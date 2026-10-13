import * as appIds from "../state/app-ids";
import { NON_STEAM_APP_APPID_MASK } from "../state/app-ids";
import { createEmitter } from "../state/emitter";
import * as library from "../state/library";
import * as artwork from "./artwork";

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

async function createShortcut(game: EpicGame): Promise<number | undefined> {
  const launch = await backend.get_launch_command(game.app_name);
  if (!launch) {
    console.debug("No launch command available", { appName: game.app_name });
    return undefined;
  }

  const appId = await SteamClient.Apps.AddShortcut(
    game.title,
    launch.exe,
    launch.start_dir,
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
  SteamClient.Apps.SetShortcutStartDir(appId, launch.start_dir);

  appIds.setAppId(game.app_name, appId);
  console.debug("Created a shortcut", { appName: game.app_name, appId, title: game.title });

  return appId;
}

function removeShortcut(appName: string, appId: number) {
  SteamClient.Apps.RemoveShortcut(appId);
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

  setState({ active: true, done: 0, total: games.length, lastResult: undefined });

  try {
    // Shortcuts the user deleted by hand would otherwise look synced forever.
    appIds.prune(
      new Set(
        appStore.allApps
          .filter((app) => app.appid >= NON_STEAM_APP_APPID_MASK)
          .map((app) => app.appid),
      ),
    );

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

        await new Promise((resolve) => setTimeout(resolve, 0));
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

/** Remove every shortcut this plugin created. */
export function removeAll() {
  for (const [appName, appId] of Object.entries(appIds.getAll())) {
    removeShortcut(appName, appId);
  }
}

/** How many of the library's games already have a shortcut. */
export function syncedCount(games: EpicGame[]) {
  const known = appIds.getAll();
  return games.filter((game) => known[game.app_name] !== undefined).length;
}
