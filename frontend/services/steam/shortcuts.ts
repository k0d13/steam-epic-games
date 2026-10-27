import * as appIds from "../../state/app-ids";
import * as library from "../../state/library";
import * as artwork from "./artwork";

// Real shortcuts get collections, search, Big Picture and playtime for free;
// they're created through SteamClient.Apps so Steam allocates the appid

export function steamShortcuts() {
  return appStore.allApps.map((app) => app.appid).filter(appIds.isShortcut);
}

// The appid map in localStorage can be lost, which would add every game again, so
// shortcuts are also recognised by running legendary with `launch "<app name>"`, then
// whatever the General page added for the game
const LEGENDARY_EXE = /(^|[\\/])legendary(\.exe)?$/i;
const LAUNCH_ARGUMENTS = /^\s*launch\s+"([^"]+)"(?=\s|$) ?(.*)$/s;

// What follows the app name and its space, untrimmed, as Steam's field compares it with
// what was typed, or options that aren't ours as they are
export function extraArguments(options: string) {
  const match = LAUNCH_ARGUMENTS.exec(options);
  return match ? (match[2] ?? "") : options;
}

// Details Steam hasn't answered in this long belong to someone else's shortcut
const DETAILS_TIMEOUT_MS = 3000;
const SCAN_BATCH_SIZE = 25;

function readOurs(appId: number) {
  return new Promise<string | undefined>((resolve) => {
    let registration: { unregister(): void } | undefined;
    let settled = false;

    const finish = (appName: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The callback can fire before Register returns, so this may still be unset
      queueMicrotask(() => registration?.unregister());
      resolve(appName);
    };

    const timer = setTimeout(() => finish(undefined), DETAILS_TIMEOUT_MS);

    registration = SteamClient.Apps.RegisterForAppDetails(appId, (details) => {
      const exe = (details.strShortcutExe ?? "").replace(/"/g, "").trim();
      const args = details.strShortcutLaunchOptions || details.strLaunchOptions || "";
      finish(LEGENDARY_EXE.test(exe) ? LAUNCH_ARGUMENTS.exec(args)?.[1] : undefined);
    });
  });
}

export async function findOurs() {
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

// A shortcut's directory is the install, for games reading relative paths and for whatever
// reads it as the install location, so it's empty, like a Steam game's, until installed.
// Its exe follows legendary, which has moved before
const startDirs = new Map<number, string>();
const alignedExes = new Set<number>();

function startDir(game: EpicGame | undefined) {
  return (game?.installed && game.install_path) || "";
}

// legendary's command, the same for every game but its arguments
let launcher: Promise<LaunchCommand | undefined> | undefined;

export async function align() {
  // Any name will do, only the arguments differ
  launcher ??= backend
    .GetLaunchCommand("")
    .then((launch) => launch ?? undefined)
    .catch(() => undefined);

  const launch = await launcher;
  if (!launch) return;

  for (const appId of library.appIdsWithGames()) {
    if (!alignedExes.has(appId)) {
      // Quoted the way Steam stores it, or a space in the path splits it
      SteamClient.Apps.SetShortcutExe(appId, `"${launch.exe}"`);
      // A compatibility tool would run legendary under Wine, where the game silently
      // never starts; legendary starts Proton itself where a game needs it
      SteamClient.Apps.SpecifyCompatTool(appId, "");
      alignedExes.add(appId);
    }

    const dir = startDir(library.getByAppId(appId));
    if (startDirs.get(appId) === dir) continue;

    SteamClient.Apps.SetShortcutStartDir(appId, dir);
    startDirs.set(appId, dir);
  }
}

// Returns the new appid, or nothing if Steam refused
export async function create(game: EpicGame) {
  const launch = await backend.GetLaunchCommand(game.app_name);
  if (!launch) {
    console.debug("No launch command available", { appName: game.app_name });
    return undefined;
  }

  const dir = startDir(game);
  const appId = await SteamClient.Apps.AddShortcut(game.title, launch.exe, dir, launch.arguments);

  if (typeof appId !== "number" || appId === 0) {
    console.warn("Steam refused to create a shortcut", { appName: game.app_name, appId });
    return undefined;
  }

  // Some client builds name the shortcut after the executable
  SteamClient.Apps.SetShortcutName(appId, game.title);
  SteamClient.Apps.SetShortcutLaunchOptions(appId, launch.arguments);
  SteamClient.Apps.SetShortcutStartDir(appId, dir);
  startDirs.set(appId, dir);
  alignedExes.add(appId);

  appIds.setAppId(game.app_name, appId);
  console.debug("Created a shortcut", { appName: game.app_name, appId, title: game.title });

  return appId;
}

// The mapping and artwork are the caller's to forget
export function remove(appId: number) {
  SteamClient.Apps.RemoveShortcut(appId);
  startDirs.delete(appId);
  alignedExes.delete(appId);
}

// Steam leaves grid images behind for removed shortcuts; returns the file count
export async function removeArtwork(ids: number[]) {
  if (ids.length === 0) return 0;

  try {
    return await backend.RemoveArtwork(ids.join(","), String(artwork.accountId() ?? ""));
  } catch (reason: unknown) {
    console.warn("Could not remove shortcut artwork", reason);
    return 0;
  }
}
