import { sleep } from "millennium";
import * as appIds from "../state/app-ids";
import * as library from "../state/library";
import * as preferences from "../state/preferences";
import { createValue } from "../state/primitives";
import * as artwork from "./artwork";
import * as collection from "./collection";
import * as hidden from "./hidden";
import * as shortcuts from "./shortcuts";

// Brings Steam's library in line with Epic's: a shortcut per game, then the
// collection and hiding the toggles ask for. Progress lives here, not in the
// panel, since a sync outlives the dialog.

export interface SyncResult {
  added: number;
  removed: number;
  failed: number;
  /** Set when the sync stopped partway, so the counts above are not the whole run. */
  error?: string;
}

export interface CleanUpResult {
  /** Shortcuts taken out of Steam. */
  removed: number;
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

/** Read with `useValue(steamLibrary.progress)`. */
export const progress = createValue<SyncState>({ active: false, done: 0, total: 0 });

const setState = progress.update;

/** Shortcuts per batch before yielding, so a first sync doesn't freeze the UI. */
const BATCH_SIZE = 10;

/** How long a clean up waits on artwork and the collection before finishing anyway. */
const TIDY_TIMEOUT_MS = 15_000;

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** How many of the library's games already have a shortcut. */
export function syncedCount(games: EpicGame[]) {
  const known = appIds.getAll();
  return games.filter((game) => known[game.app_name] !== undefined).length;
}

/**
 * Bring the appid map in line with the shortcuts actually in Steam: adopt ones it
 * lost, and remove every extra shortcut for a game that already has one.
 */
async function adoptExisting(): Promise<number> {
  const keep = new Map<string, number>();
  const extras: number[] = [];

  for (const { appId, appName } of await shortcuts.findOurs()) {
    const kept = keep.get(appName);
    if (kept === undefined) {
      keep.set(appName, appId);
    } else if (appId === appIds.getAppId(appName)) {
      // The mapped one wins, since it's the one with our artwork applied.
      extras.push(kept);
      keep.set(appName, appId);
    } else {
      extras.push(appId);
    }
  }

  for (const [appName, appId] of keep) {
    if (appIds.getAppId(appName) === appId) continue;
    appIds.setAppId(appName, appId);
    // Its artwork may be another install's, or none at all.
    artwork.forget(appName);
  }

  for (const appId of extras) shortcuts.remove(appId);
  await shortcuts.removeArtwork(extras);

  if (extras.length > 0) console.info("Removed duplicate shortcuts", { count: extras.length });
  return extras.length;
}

/**
 * Reconcile the Epic library with Steam's shortcuts, touching only what differs,
 * then apply the toggles so they cover games the sync just added.
 */
export async function sync(games: EpicGame[]): Promise<SyncResult> {
  const result: SyncResult = { added: 0, removed: 0, failed: 0 };
  if (progress.get().active) return result;

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
    appIds.prune(new Set(shortcuts.steamShortcuts()));

    // A game that left the account would launch into an ownership error.
    const owned = new Set(games.map((game) => game.app_name));
    for (const [appName, appId] of Object.entries(appIds.getAll())) {
      if (owned.has(appName)) continue;
      shortcuts.remove(appId);
      appIds.removeAppName(appName);
      artwork.forget(appName);
      result.removed++;
    }

    let done = 0;
    let unindexed = false;

    for (const game of games) {
      const existing = appIds.getAppId(game.app_name);
      const appId = existing ?? (await shortcuts.create(game));

      if (appId === undefined) {
        result.failed++;
      } else if (existing === undefined) {
        result.added++;
        unindexed = true;
      }

      // Also covers shortcuts made by a sync that was interrupted partway.
      if (appId !== undefined && !artwork.isDone(game.app_name)) await artwork.apply(appId, game);

      setState({ done: ++done });

      if (done % BATCH_SIZE === 0) {
        // Unmapped shortcuts read as installed, so reindex each batch to keep that short.
        if (unindexed) library.reindexAppIds();
        unindexed = false;
        await sleep(0);
      }
    }

    const { collection: collect, hideDuplicates } = preferences.get();
    if (hideDuplicates) hidden.setDuplicatesHidden(games, true);
    const error = collect ? await collection.addAll(games) : undefined;
    if (error) console.warn("Couldn't fill the collection", error);

    console.info("Shortcut sync complete", result);
    return result;
  } catch (reason: unknown) {
    // Returned, not thrown: the panel may not be open to catch it.
    console.error("Shortcut sync failed", reason);
    result.error = message(reason);
    return result;
  } finally {
    // The appid map changed either way, and every patch reads the library.
    library.reindexAppIds();
    setState({ active: false, done: 0, total: 0, lastResult: result });
  }
}

/**
 * Sync after a library load when the user has opted in: auto sync is on and
 * they've added games before. Skipped when nothing differs, which saves a scan
 * of every shortcut on each startup.
 */
export async function autoSync(epic: Library) {
  if (!preferences.get().autoSync || progress.get().active) return;

  // An errored or empty load would read as every game leaving the account.
  const games = epic.games;
  if (epic.error || games.length === 0) return;

  // A shortcut removed outside the plugin still has its mapping, which would
  // count it as synced and skip it. Steam's list is empty until it loads.
  const inSteam = shortcuts.steamShortcuts();
  if (inSteam.length > 0) appIds.prune(new Set(inSteam));

  const synced = syncedCount(games);
  if (synced === 0) return;

  const owned = new Set(games.map((game) => game.app_name));
  const gone = Object.keys(appIds.getAll()).some((appName) => !owned.has(appName));
  if (synced === games.length && !gone) return;

  console.info("Library changed, syncing", { synced, total: games.length, gone });
  await sync(games);
}

/** Turning hiding off shows the duplicates again, and only them. */
export function setHideDuplicates(games: EpicGame[], value: boolean) {
  preferences.set("hideDuplicates", value);
  hidden.setDuplicatesHidden(games, value);
}

/**
 * Turning the collection off deletes it, unless the user added games of their own.
 * Returns why it couldn't be filled, if it couldn't.
 */
export async function setCollection(games: EpicGame[], value: boolean) {
  preferences.set("collection", value);
  if (value) return collection.addAll(games);
  await collection.removeIfEmpty(new Set(Object.values(appIds.getAll())));
  return undefined;
}

/**
 * Remove every shortcut this plugin ever made, whether or not it still knows
 * about them, with their artwork and the collection, and forget it all.
 * Installed games and the Epic sign-in are left alone.
 */
export async function cleanUp(): Promise<CleanUpResult> {
  if (progress.get().active) return { removed: 0, error: "A sync is still running." };

  setState({ active: true, operation: "cleanUp", done: 0, total: 0, lastResult: undefined });

  try {
    const ids = new Set(Object.values(appIds.getAll()));
    for (const { appId } of await shortcuts.findOurs()) ids.add(appId);

    // The map can hold appids Steam no longer has; removing those is a no-op.
    const present = new Set(appStore.allApps.map((app) => app.appid));
    const removed = [...ids].filter((appId) => present.has(appId)).length;

    setState({ total: ids.size });

    let done = 0;
    for (const appId of ids) {
      shortcuts.remove(appId);
      setState({ done: ++done });
      if (done % BATCH_SIZE === 0) await sleep(0);
    }

    // Before anything that waits, so the shortcuts being gone is never forgotten.
    appIds.clear();
    artwork.forgetAll();
    library.reindexAppIds();

    // Bounded: the backend answers one call at a time, and either can keep the
    // progress bar up indefinitely.
    const timeout = sleep(TIDY_TIMEOUT_MS);
    const [artworkRemoved] = await Promise.all([
      Promise.race([shortcuts.removeArtwork([...ids]), timeout]),
      Promise.race([collection.removeIfEmpty(ids), timeout]),
    ]);

    console.info("Cleaned up the Steam library", { removed, artworkRemoved });
    return { removed };
  } catch (reason: unknown) {
    console.error("Clean up failed", reason);
    return { removed: 0, error: message(reason) };
  } finally {
    library.reindexAppIds();
    setState({ active: false, done: 0, total: 0 });
  }
}
