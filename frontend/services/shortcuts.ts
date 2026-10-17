import { sleep } from "millennium";
import { registerUnpatched } from "../patches/app-details";
import * as appIds from "../state/app-ids";
import { createEmitter } from "../state/emitter";
import * as library from "../state/library";
import * as artwork from "./artwork";
import * as collection from "./collection";

// Real shortcuts get collections, search, Big Picture and playtime for free.
// Created through SteamClient.Apps so Steam allocates the appid.

export interface SyncResult {
  added: number;
  removed: number;
  failed: number;
  /** Individual images applied, not games - a game is worth up to four. */
  artworkApplied: number;
  /** Set when the sync stopped partway, so the counts above are not the whole run. */
  error?: string;
}

interface SyncState {
  active: boolean;
  /** A clean up shares the flag, so neither starts while the other runs. */
  operation?: "sync" | "cleanUp";
  done: number;
  total: number;
  /** What the last finished sync did, kept so a panel opened later can say so. */
  lastResult?: SyncResult;
}

// Progress lives here, not in the panel, since a sync outlives the dialog.

let state: SyncState = { active: false, done: 0, total: 0 };

const emitter = createEmitter();
export const subscribeToSync = emitter.subscribe;

function setState(next: Partial<SyncState>) {
  state = { ...state, ...next };
  emitter.emit();
}

export function getSyncState(): SyncState {
  return state;
}

/** Shortcuts per batch before yielding, so a first sync doesn't freeze the UI. */
const BATCH_SIZE = 10;

// The appid map lives in localStorage, which a reinstall or a dev build can lose
// or keep separately, and a sync without it adds every game again. So shortcuts
// are also recognised by what they run: legendary, from wherever it was, with
// the `launch "<app name>"` GetLaunchCommand gives them.

const LEGENDARY_EXE = /(^|[\\/])legendary\.exe$/i;
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

interface FoundShortcut {
  appId: number;
  appName: string;
}

/** Every shortcut in Steam that launches an Epic game through legendary. */
async function findOurs(): Promise<FoundShortcut[]> {
  const candidates = appStore.allApps.map((app) => app.appid).filter(appIds.isShortcut);
  const found: FoundShortcut[] = [];

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

/**
 * Bring the appid map in line with the shortcuts actually in Steam: adopt ones it
 * lost, and remove every extra shortcut for a game that already has one.
 */
async function adoptExisting(): Promise<number> {
  const keep = new Map<string, number>();
  const extras: FoundShortcut[] = [];

  for (const shortcut of await findOurs()) {
    const kept = keep.get(shortcut.appName);
    const mapped = appIds.getAppId(shortcut.appName);

    if (kept === undefined) {
      keep.set(shortcut.appName, shortcut.appId);
    } else if (shortcut.appId === mapped) {
      // The mapped one wins, since it's the one with our artwork applied.
      extras.push({ appId: kept, appName: shortcut.appName });
      keep.set(shortcut.appName, shortcut.appId);
    } else {
      extras.push(shortcut);
    }
  }

  for (const [appName, appId] of keep) {
    if (appIds.getAppId(appName) === appId) continue;
    appIds.setAppId(appName, appId);
    // Its artwork may be another install's, or none at all.
    artwork.forget(appName);
  }

  for (const { appId } of extras) SteamClient.Apps.RemoveShortcut(appId);
  await removeArtwork(extras.map((shortcut) => shortcut.appId));

  if (extras.length > 0) console.info("Removed duplicate shortcuts", { count: extras.length });
  return extras.length;
}

/** Delete the grid images Steam leaves behind for removed shortcuts. Returns the file count. */
async function removeArtwork(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  try {
    return await backend.RemoveArtwork(ids.join(","), artwork.accountId());
  } catch (reason: unknown) {
    console.warn("Could not remove shortcut artwork", reason);
    return 0;
  }
}

/** How long a clean up waits on artwork and the collection before finishing anyway. */
const TIDY_TIMEOUT_MS = 15_000;

/** The promise's value, or `undefined` once `ms` pass; the work itself carries on. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, sleep(ms).then(() => undefined)]);
}

async function createShortcut(game: EpicGame): Promise<number | undefined> {
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

function removeShortcut(appName: string, appId: number) {
  SteamClient.Apps.RemoveShortcut(appId);
  startDirs.delete(appId);
  alignedExes.delete(appId);
  appIds.removeAppName(appName);
  artwork.forget(appName);
  console.debug("Removed a shortcut", { appName, appId });
}

/** Reconcile the Epic library with Steam's shortcuts, touching only what differs. */
export async function sync(games: EpicGame[]): Promise<SyncResult> {
  const result: SyncResult = { added: 0, removed: 0, failed: 0, artworkApplied: 0 };

  if (state.active) {
    console.debug("A sync is already in progress, skipping this one");
    return result;
  }

  setState({
    active: true,
    operation: "sync",
    done: 0,
    total: games.length,
    lastResult: undefined,
  });

  try {
    // Before anything is created, or a lost map adds every game a second time.
    result.removed += await adoptExisting();

    // Shortcuts the user deleted by hand would otherwise look synced forever.
    appIds.prune(new Set(appStore.allApps.map((app) => app.appid).filter(appIds.isShortcut)));

    const known = appIds.getAll();
    const owned = new Set(games.map((game) => game.app_name));

    // A game that left the account would launch into an ownership error.
    for (const [appName, appId] of Object.entries(known)) {
      if (owned.has(appName)) continue;
      removeShortcut(appName, appId);
      result.removed++;
    }

    let sinceYield = 0;
    let done = 0;
    let addedSinceReindex = 0;

    for (const game of games) {
      const existing = appIds.getAppId(game.app_name);
      const appId = existing ?? (await createShortcut(game));

      if (appId === undefined) {
        result.failed++;
      } else {
        if (existing === undefined) {
          result.added++;
          addedSinceReindex++;
        }

        // Also covers shortcuts made by a sync that was interrupted partway.
        if (!artwork.isDone(game.app_name)) {
          result.artworkApplied += await artwork.apply(appId, game);
        }
      }

      setState({ done: ++done });

      if (++sinceYield >= BATCH_SIZE) {
        sinceYield = 0;

        // Unmapped shortcuts read as installed, so reindex each batch to keep that short.
        if (addedSinceReindex > 0) {
          addedSinceReindex = 0;
          library.reindexAppIds();
        }

        await sleep(0);
      }
    }

    console.info("Shortcut sync complete", result);
    return result;
  } catch (reason: unknown) {
    // Returned, not thrown: the panel may not be open to catch it.
    console.error("Shortcut sync failed", reason);
    result.error = reason instanceof Error ? reason.message : String(reason);
    return result;
  } finally {
    // The appid map changed either way, and every patch reads the library.
    library.reindexAppIds();
    setState({ active: false, done: 0, total: 0, lastResult: result });
  }
}

// A shortcut is made before its game exists, so it starts in legendary's folder.
// Games that read files relative to their working directory need their own, so
// it follows the install. The exe follows legendary, which has moved before and
// would leave older shortcuts launching a stale copy. Set once a session per
// shortcut, then on each change.

/** The working directory each shortcut was last given this session. */
const startDirs = new Map<number, string>();

/** Shortcuts whose exe has been pointed at legendary this session. */
const alignedExes = new Set<number>();

/** legendary's command, the same for every game but its arguments. */
let launcher: Promise<LaunchCommand | undefined> | undefined;

/** Point every shortcut at legendary, working in its game folder or legendary's. */
export async function alignShortcuts() {
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
      alignedExes.add(appId);
    }

    const game = library.getByAppId(appId);
    const dir = (game?.installed && game.install_path) || launch.start_dir;
    if (startDirs.get(appId) === dir) continue;

    SteamClient.Apps.SetShortcutStartDir(appId, dir);
    startDirs.set(appId, dir);
  }
}

/**
 * Remove every shortcut this plugin ever made, whether or not it still knows
 * about them, with their artwork and the collection, and forget it all.
 * Installed games and the Epic sign-in are left alone.
 */
export async function cleanUp(): Promise<CleanUpResult> {
  if (state.active) return { removed: 0, error: "A sync is still running." };

  setState({ active: true, operation: "cleanUp", done: 0, total: 0, lastResult: undefined });

  try {
    const ids = new Set(Object.values(appIds.getAll()));
    for (const { appId } of await findOurs()) ids.add(appId);

    // The map can hold appids Steam no longer has; removing those is a no-op.
    const present = new Set(appStore.allApps.map((app) => app.appid));
    const removed = [...ids].filter((appId) => present.has(appId)).length;

    setState({ total: ids.size });

    let done = 0;
    for (const appId of ids) {
      SteamClient.Apps.RemoveShortcut(appId);
      startDirs.delete(appId);
      alignedExes.delete(appId);
      setState({ done: ++done });
      if (done % BATCH_SIZE === 0) await sleep(0);
    }

    // Before anything that waits, so the shortcuts being gone is never forgotten.
    appIds.clear();
    artwork.forgetAll();
    library.reindexAppIds();

    // Bounded: the backend answers one call at a time, and the collection API is
    // untyped, so either can keep the progress bar up indefinitely.
    const [artworkRemoved, collectionRemoved] = await Promise.all([
      withTimeout(removeArtwork([...ids]), TIDY_TIMEOUT_MS),
      withTimeout(collection.removeIfEmpty(ids), TIDY_TIMEOUT_MS),
    ]);

    console.info("Cleaned up the Steam library", {
      removed,
      artworkRemoved,
      collectionRemoved,
    });
    return { removed };
  } catch (reason: unknown) {
    console.error("Clean up failed", reason);
    return { removed: 0, error: reason instanceof Error ? reason.message : String(reason) };
  } finally {
    library.reindexAppIds();
    setState({ active: false, done: 0, total: 0 });
  }
}

export interface CleanUpResult {
  /** Shortcuts taken out of Steam. */
  removed: number;
  error?: string;
}

/** How many of the library's games already have a shortcut. */
export function syncedCount(games: EpicGame[]) {
  const known = appIds.getAll();
  return games.filter((game) => known[game.app_name] !== undefined).length;
}
