import { registerUnpatched } from "../patches/app-details";
import * as appIds from "../state/app-ids";
import * as library from "../state/library";
import * as artwork from "./artwork";

// Real shortcuts get collections, search, Big Picture and playtime for free.
// Created through SteamClient.Apps so Steam allocates the appid.

/** Every shortcut appid in Steam, ours or anyone's. Empty until Steam's list loads. */
export const steamShortcuts = () =>
  appStore.allApps.map((app) => app.appid).filter(appIds.isShortcut);

// The appid map lives in localStorage, which a reinstall or a dev build can lose
// or keep separately, and a sync without it adds every game again. So shortcuts
// are also recognised by what they run: legendary, from wherever it was, with
// the `launch "<app name>"` GetLaunchCommand gives them.

const LEGENDARY_EXE = /(^|[\\/])legendary(\.exe)?$/i;
const LAUNCH_ARGUMENTS = /^\s*launch\s+"([^"]+)"\s*$/;

/** Details Steam hasn't answered in this long are treated as someone else's shortcut. */
const DETAILS_TIMEOUT_MS = 3000;

/** Shortcuts asked about at once while scanning. */
const SCAN_BATCH_SIZE = 25;

/** The Epic app name a shortcut launches, if it's one of ours. */
function readOurs(appId: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let registration: { unregister(): void } | undefined;
    let settled = false;

    const finish = (appName: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The callback can fire before Register returns, so this may still be unset.
      queueMicrotask(() => registration?.unregister());
      resolve(appName);
    };

    const timer = setTimeout(() => finish(undefined), DETAILS_TIMEOUT_MS);

    registration = registerUnpatched(appId, (details) => {
      const exe = (details.strShortcutExe ?? "").replace(/"/g, "").trim();
      const args = details.strShortcutLaunchOptions || details.strLaunchOptions || "";
      finish(LEGENDARY_EXE.test(exe) ? LAUNCH_ARGUMENTS.exec(args)?.[1] : undefined);
    });
  });
}

/** Every shortcut in Steam that launches an Epic game through legendary. */
export async function findOurs(): Promise<{ appId: number; appName: string }[]> {
  const candidates = steamShortcuts();
  const found: { appId: number; appName: string }[] = [];

  for (let start = 0; start < candidates.length; start += SCAN_BATCH_SIZE) {
    const batch = candidates.slice(start, start + SCAN_BATCH_SIZE);
    const names = await Promise.all(batch.map(readOurs));

    batch.forEach((appId, index) => {
      const appName = names[index];
      if (appName) found.push({ appId, appName });
    });
  }

  console.debug("Scanned shortcuts", { shortcuts: candidates.length, ours: found.length });
  return found;
}

// A shortcut is made before its game exists, so it starts in legendary's folder.
// Games that read files relative to their working directory need their own, so
// it follows the install. The exe follows legendary, which has moved before and
// would leave older shortcuts launching a stale copy. Set once a session per
// shortcut, then on each change.

/** The working directory each shortcut was last given this session. */
const startDirs = new Map<number, string>();

/** Steam's UI is Chromium, whose user agent names the OS. */
const IS_LINUX = navigator.userAgent.includes("Linux");

/** Shortcuts whose exe has been pointed at legendary this session. */
const alignedExes = new Set<number>();

/** legendary's command, the same for every game but its arguments. */
let launcher: Promise<LaunchCommand | undefined> | undefined;

/** Point every shortcut at legendary, working in its game folder or legendary's. */
export async function align() {
  // Any name will do, only the arguments differ.
  launcher ??= backend
    .GetLaunchCommand("")
    .then((launch) => launch ?? undefined)
    .catch(() => undefined);

  const launch = await launcher;
  if (!launch) return;

  for (const appId of library.appIdsWithGames()) {
    if (!alignedExes.has(appId)) {
      // Quoted the way Steam stores it, or a space in the path splits it.
      SteamClient.Apps.SetShortcutExe(appId, `"${launch.exe}"`);
      // legendary is a Linux binary that starts Proton itself. A compatibility
      // tool on the shortcut would run it under Wine, where the game silently
      // never starts, so any set in Properties is cleared.
      if (IS_LINUX) SteamClient.Apps.SpecifyCompatTool(appId, "");
      alignedExes.add(appId);
    }

    const game = library.getByAppId(appId);
    const dir = (game?.installed && game.install_path) || launch.start_dir;
    if (startDirs.get(appId) === dir) continue;

    SteamClient.Apps.SetShortcutStartDir(appId, dir);
    startDirs.set(appId, dir);
  }
}

/** Add a game's shortcut and map it. Returns its appid, or nothing if Steam refused. */
export async function create(game: EpicGame): Promise<number | undefined> {
  const launch = await backend.GetLaunchCommand(game.app_name);
  if (!launch) {
    console.debug("No launch command available", { appName: game.app_name });
    return undefined;
  }

  // Installed games start in their own folder, so nothing reading the shortcut
  // ever sees legendary's.
  const startDir = (game.installed && game.install_path) || launch.start_dir;

  const appId = await SteamClient.Apps.AddShortcut(
    game.title,
    launch.exe,
    startDir,
    launch.arguments,
  );

  if (typeof appId !== "number" || appId === 0) {
    console.warn("Steam refused to create a shortcut", { appName: game.app_name, appId });
    return undefined;
  }

  // Some client builds name the shortcut after the executable, which would make
  // every one of ours "legendary.exe".
  SteamClient.Apps.SetShortcutName(appId, game.title);
  SteamClient.Apps.SetShortcutLaunchOptions(appId, launch.arguments);
  SteamClient.Apps.SetShortcutStartDir(appId, startDir);
  startDirs.set(appId, startDir);
  alignedExes.add(appId);

  appIds.setAppId(game.app_name, appId);
  console.debug("Created a shortcut", { appName: game.app_name, appId, title: game.title });

  return appId;
}

/** Take a shortcut out of Steam. Its mapping and artwork are the caller's to forget. */
export function remove(appId: number) {
  SteamClient.Apps.RemoveShortcut(appId);
  startDirs.delete(appId);
  alignedExes.delete(appId);
}

/** Delete the grid images Steam leaves behind for removed shortcuts. Returns the file count. */
export async function removeArtwork(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  try {
    return await backend.RemoveArtwork(ids.join(","), String(artwork.accountId() ?? ""));
  } catch (reason: unknown) {
    console.warn("Could not remove shortcut artwork", reason);
    return 0;
  }
}
