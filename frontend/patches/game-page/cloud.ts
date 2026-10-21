import { type AppDetails, callOriginal, findModuleExport, replacePatch } from "millennium";
import { notify } from "../../services/steam/notifications";
import { isRunning } from "../../services/steam/playtime";
import { mainPopup } from "../../services/steam/popups";
import * as cloud from "../../state/cloud";
import * as library from "../../state/library";

// Epic's cloud saves the way Steam's own work: synced before a launch and after the
// game exits, with the play bar's Cloud Status, which backend/patches.lua lets a
// shortcut have, and Steam's conflict and failure dialogs and notifications. Those
// call SteamClient.Cloud with the appid, which we answer for an Epic game

// EAppCloudStatus
const STATUS = {
  unknown: 2,
  synchronized: 3,
  checking: 4,
  outOfSync: 5,
  uploading: 6,
  downloading: 7,
  syncFailed: 8,
  conflict: 9,
} as const;

interface CloudDialogProps {
  appid: number;
  // The launch wording, and for a failure a button that plays anyway
  bOnAppLaunch: boolean;
  onCancel(): void;
  onOK(): void;
  keepLocal?(): void;
  keepRemote?(): void;
}

type CloudDialog = (props: CloudDialogProps, owner: Window) => void;

function findDialog(logged: string) {
  const dialog = findModuleExport(
    (value) => typeof value === "function" && String(value).includes(logged),
  ) as CloudDialog | undefined;
  if (!dialog) console.warn(`Steam's dialog that logs "${logged}" wasn't found`);
  return dialog;
}

const showConflictDialog = findDialog("showing cloud conflict dialog");
const showSyncFailedDialog = findDialog("showing cloud sync failed dialog");

// Epic games that have saves to sync, and were installed to make any
function syncable(appId: number) {
  const game = library.getByAppId(appId);
  if (!game?.installed || !game.cloud_saves) return undefined;
  return cloud.get(game.app_name)?.status === "unavailable" ? undefined : game;
}

function status(appName: string) {
  const activity = cloud.getActivity(appName);
  if (activity === "checking") return STATUS.checking;
  if (activity === "upload") return STATUS.uploading;
  if (activity === "download") return STATUS.downloading;

  switch (cloud.get(appName)?.status) {
    case "synced":
      return STATUS.synchronized;
    case "upload":
    case "download":
      return STATUS.outOfSync;
    case "conflict":
      return STATUS.conflict;
    case "failed":
      return STATUS.syncFailed;
    default:
      return STATUS.unknown;
  }
}

// For library/app-details; the play bar shows the status while all three are set
export function applyCloud(details: AppDetails, game: EpicGame) {
  const available = syncable(details.unAppID) !== undefined;
  details.bCloudAvailable = available;
  details.bCloudEnabledForApp = available;
  details.bCloudEnabledForAccount = true;
  if (available) details.eCloudStatus = status(game.app_name);
}

// For library/app-details, as a page opening asks for its app's details
export function checkCloud(appId: number) {
  const game = syncable(appId);
  if (game) cloud.ensure(game.app_name);
}

function owner() {
  return mainPopup()?.window ?? window;
}

// The side the user kept, or undefined if they backed out
function askConflict(appId: number, onLaunch: boolean) {
  return new Promise<cloud.Direction | undefined>((resolve) => {
    if (!showConflictDialog) return resolve(undefined);
    showConflictDialog(
      {
        appid: appId,
        bOnAppLaunch: onLaunch,
        onCancel: () => resolve(undefined),
        onOK: () => resolve(undefined),
        keepLocal: () => resolve("upload"),
        keepRemote: () => resolve("download"),
      },
      owner(),
    );
  });
}

// True to go ahead: play anyway on a launch, try again otherwise
function askFailed(appId: number, onLaunch: boolean) {
  return new Promise<boolean>((resolve) => {
    if (!showSyncFailedDialog) return resolve(onLaunch);
    showSyncFailedDialog(
      {
        appid: appId,
        bOnAppLaunch: onLaunch,
        onCancel: () => resolve(false),
        onOK: () => resolve(true),
      },
      owner(),
    );
  });
}

// A shortcut's game id is its appid shifted up 32 bits, over the shortcut flag
function appIdOf(gameId: string) {
  try {
    return Number(BigInt(gameId) >> 32n);
  } catch {
    return 0;
  }
}

const launching = new Set<number>();

// Undefined when a launch is already syncing, as Steam marks the game launched as it
// asks, so a second click lands here mid-sync. Not held over a dialog, which could
// close without answering and leave the game unable to start
async function syncForLaunch(appId: number, appName: string, direction?: cloud.Direction) {
  if (launching.has(appId)) return undefined;
  launching.add(appId);
  try {
    return await cloud.sync(appName, direction);
  } finally {
    launching.delete(appId);
  }
}

async function launchAfterSync(appId: number, appName: string, launch: () => void) {
  let result = await syncForLaunch(appId, appName);
  if (!result) return;

  if (result.status === "conflict") {
    // Without the dialog, both sides' changes stay put and the conflict stays shown
    if (!showConflictDialog) return launch();
    const keep = await askConflict(appId, true);
    if (!keep) return;
    result = await syncForLaunch(appId, appName, keep);
    if (!result) return;
  }

  if (result.status === "failed" && !(await askFailed(appId, true))) return;
  launch();
}

// For the entry's session end, with the play time
export async function syncAfterExit(appId: number) {
  const game = syncable(appId);
  if (!game) return;
  const result = await cloud.sync(game.app_name);
  // Steam's own notifications, which open the game's page, where the play bar settles it
  if (result.status === "conflict") notify("cloud-sync-conflict", appId);
  else if (result.status === "failed") notify("cloud-sync-failed", appId);
}

// The play bar's status, clicked when it shows a conflict or a failure
async function settle(appId: number, appName: string, keep?: cloud.Direction) {
  const result = await cloud.sync(appName, keep);
  if (result.status === "conflict") {
    const chosen = await askConflict(appId, false);
    if (chosen) await cloud.sync(appName, chosen);
  }
}

export function register() {
  const runGame = replacePatch(SteamClient.Apps, "RunGame", (args) => {
    const appId = appIdOf(args[0]);
    const game = syncable(appId);
    // A running game's files are in use, and Steam says it's running itself
    if (!game || isRunning(appId)) return callOriginal as never;

    void launchAfterSync(appId, game.app_name, () =>
      runGame.original.apply(SteamClient.Apps, args),
    );
  });

  const patches = [
    runGame,

    replacePatch(SteamClient.Cloud, "ResolveAppSyncConflict", (args) => {
      const [appId, keepLocal] = args;
      const game = syncable(appId);
      if (!game) return callOriginal as never;
      void settle(appId, game.app_name, keepLocal ? "upload" : "download");
    }),

    replacePatch(SteamClient.Cloud, "RetryAppSync", (args) => {
      const [appId] = args;
      const game = syncable(appId);
      if (!game) return callOriginal as never;
      void settle(appId, game.app_name);
    }),

    // What the conflict dialog shows as each side's last change
    replacePatch(SteamClient.Apps, "GetConflictingFileTimestamps", (args) => {
      const [appId] = args;
      const game = syncable(appId);
      if (!game) return callOriginal as never;
      const saves = cloud.get(game.app_name);
      return Promise.resolve({
        rtLocalTime: saves?.local_at ?? 0,
        rtRemoteTime: saves?.remote_at ?? 0,
      });
    }),
  ];

  return () => patches.forEach((patch) => patch.unpatch());
}
