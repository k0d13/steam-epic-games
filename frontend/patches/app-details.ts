import { callOriginal, replacePatch } from "@steambrew/client";
import { logger } from "../index";
import { once } from "../services/once";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import * as sizes from "../state/sizes";
import { getAchievements, type SteamAchievements } from "./achievements";

// Steam's play bar shows "Space Required" beside Install for a game that isn't
// on disk yet, and drops it once the install starts. It isn't a component to
// replace - it's drawn from two fields on the app's details,
// `bHasAnyLocalContent` and `lDiskSpaceRequiredBytes`, and a shortcut points at
// a file on disk so Steam gets both wrong for every Epic game.
//
// The obvious place to correct them is appDetailsStore.AppDetailsChanged, but
// that's a mobx action and mobx 6 makes those non-writable. So we patch one
// step earlier, at the client callback the store registers - the same thing
// every update arrives through.

/** Only the fields we touch; details carry several dozen. */
interface AppDetails {
  unAppID: number;
  bHasAnyLocalContent?: boolean;
  lDiskSpaceRequiredBytes?: number;
  achievements?: SteamAchievements;
}

interface AppData {
  details?: AppDetails;
}

interface AppDetailsStore {
  /** Callable, but not patchable - see above. */
  AppDetailsChanged(details: AppDetails): void;
  m_mapAppData: Map<number, AppData>;
}

type DetailsCallback = (details: AppDetails) => void;

interface AppsApi extends Record<PropertyKey, unknown> {
  RegisterForAppDetails(appId: number, callback: DetailsCallback): { unregister(): void };
}

function getStore(): AppDetailsStore | undefined {
  return Reflect.get(globalThis, "appDetailsStore") as AppDetailsStore | undefined;
}

function getApps(): AppsApi {
  return SteamClient.Apps as unknown as AppsApi;
}

const logApplied = once((details: AppDetails, appName: string) => {
  logger.debug("App details patch applied", {
    appId: details.unAppID,
    appName,
    // Anything else means the fields are read-only or renamed on this build and
    // none of it is taking effect.
    gotLocalContent: details.bHasAnyLocalContent,
    gotRequired: details.lDiskSpaceRequiredBytes,
  });
});

/**
 * Rewrite one app's details to match what Epic says. The disk-space half is
 * skipped for installed games, since Steam's answer for them is already right.
 *
 * A game part-way through an install counts as installed here: Steam drops the
 * row once its own download starts, which is what stops the play bar shifting
 * under the cursor as the progress bar appears.
 */
function apply(details: AppDetails) {
  const game = library.getByAppId(details.unAppID);
  if (!game) return;

  // Achievements go on whether the game is installed or not - Epic keeps them
  // against the account, so an uninstalled game still has a record to show.
  // Left alone rather than blanked while we're waiting on Epic, so the section
  // doesn't flicker out between reads.
  const achievements = getAchievements(game.appName);
  if (achievements) details.achievements = achievements;

  if (game.installed) return;

  // Any job state, not just running: a finished install is on disk while
  // library.installed catches up a poll later, which is long enough for the row
  // to flash back in between.
  const job = jobs.get(game.appName);
  if (job?.kind === "install") {
    details.bHasAnyLocalContent = true;
    return;
  }

  details.bHasAnyLocalContent = false;

  const size = sizes.get(game.appName);
  if (size) details.lDiskSpaceRequiredBytes = size.disk;
  // Reading it fetches the game's manifest from Epic, so it's started here and
  // drawn on the pass after it lands.
  else sizes.ensure(game.appName);

  logApplied(details, game.appName);
}

export function register() {
  // replacePatch, because the point is to swap out an argument: `args` is what
  // the original is called with, so our wrapper goes in front of every update.
  const patch = replacePatch(getApps(), "RegisterForAppDetails", (args) => {
    const [, callback] = args as [number, DetailsCallback];

    args[1] = (details: AppDetails) => {
      apply(details);
      callback(details);
    };

    // Forwards to the real function with the arguments we just edited. The cast
    // is replacePatch's typing being narrower than the function really is.
    return callOriginal as unknown as ReturnType<AppsApi["RegisterForAppDetails"]>;
  });

  // A size arriving is asynchronous and has no other way back into the UI.
  const unsubscribe = sizes.subscribe(() => refreshAll());

  logger.debug("Registered the app details patch");

  return () => {
    patch.unpatch();
    unsubscribe();
  };
}

/**
 * Correct the details Steam is already holding, and get them re-read.
 * AppDetailsChanged can't be patched but it can be called, and it notifies the
 * same listeners the client's own updates do.
 *
 * It has to be a copy: the store holds details by reference, so re-submitting
 * the same object gives its observers no reason to re-render.
 */
export function refreshAll() {
  const store = getStore();
  if (!store || library.isEmpty()) return;

  for (const data of store.m_mapAppData.values()) {
    const details = data.details;
    if (!details || library.getByAppId(details.unAppID) === undefined) continue;

    const updated = { ...details };
    apply(updated);

    // Only when the pass wrote something new: a repaint happens on every jobs
    // poll, and re-submitting unchanged details re-renders the app page for
    // nothing. Against what we last sent, since the store's copy is Steam's.
    const signature = sign(updated);
    if (applied.get(details.unAppID) === signature) continue;

    applied.set(details.unAppID, signature);
    store.AppDetailsChanged(updated);
  }
}

/** What we last sent for an app, so an unchanged pass costs no re-render. */
const applied = new Map<number, string>();

const sign = (details: AppDetails) =>
  [
    details.bHasAnyLocalContent,
    details.lDiskSpaceRequiredBytes,
    details.achievements?.nAchieved,
    details.achievements?.nTotal,
  ].join("|");
