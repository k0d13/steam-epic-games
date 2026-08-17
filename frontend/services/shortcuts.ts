import { NON_STEAM_APP_APPID_MASK, Steam } from "steambrew-utils";
import { logger } from "../index";
import rpc, { type EpicGame } from "../rpc";
import * as appIds from "../state/app-ids";
import * as library from "../state/library";
import * as artwork from "./artwork";

// Every Epic game becomes a real non-Steam shortcut. That's what buys us
// persistence, collections, search, Big Picture and playtime for free - a purely
// virtual entry injected into appStore would have none of it and would evaporate
// on restart. They go through SteamClient.Apps rather than shortcuts.vdf so that
// Steam allocates the appid and we never touch binary VDF.

export interface SyncResult {
  added: number;
  removed: number;
  failed: number;
  /** Individual images applied, not games - a game is worth up to four. */
  artworkApplied: number;
  total: number;
}

export interface SyncState {
  active: boolean;
  done: number;
  total: number;
  /** What the last finished sync did, kept so a panel opened later can say so. */
  lastResult?: SyncResult;
}

// A sync outlives the panel that started it: it takes minutes over a few hundred
// games, and the plugin panel is a dialog the user closes. Holding its progress
// in the panel's own state meant closing it lost the bar and the busy flag, and
// reopening showed an idle panel with a sync still running behind it. So the
// state lives here, and the panel is one of its subscribers.

let state: SyncState = { active: false, done: 0, total: 0 };

const listeners = new Set<() => void>();

function setState(next: Partial<SyncState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getSyncState(): SyncState {
  return state;
}

export function subscribeToSync(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * How many shortcuts to create before yielding back to the event loop. Each one
 * round-trips to the Steam client, and a first sync of a couple of hundred games
 * would otherwise hold the UI thread long enough to look like a hang.
 */
const BATCH_SIZE = 10;

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

function existingShortcutIds(): Set<number> {
  return new Set(
    Steam.AppStore.allApps
      .filter((app) => app.appid >= NON_STEAM_APP_APPID_MASK)
      .map((app) => app.appid),
  );
}

async function createShortcut(game: EpicGame): Promise<number | undefined> {
  const launch = await rpc.GetLaunchCommand(game.appName);
  if (!launch) {
    logger.debug("No launch command available", { appName: game.appName });
    return undefined;
  }

  const appId = await SteamClient.Apps.AddShortcut(
    game.title,
    launch.exe,
    launch.startDir,
    launch.arguments,
  );

  if (typeof appId !== "number" || appId === 0) {
    logger.warn("Steam refused to create a shortcut", { appName: game.appName, appId });
    return undefined;
  }

  // AddShortcut names the shortcut after the executable on some client builds,
  // and every one of ours would then be called "legendary.exe".
  SteamClient.Apps.SetShortcutName(appId, game.title);
  SteamClient.Apps.SetShortcutLaunchOptions(appId, launch.arguments);
  SteamClient.Apps.SetShortcutStartDir(appId, launch.startDir);

  appIds.setAppId(game.appName, appId);
  logger.debug("Created a shortcut", { appName: game.appName, appId, title: game.title });

  return appId;
}

function removeShortcut(appName: string, appId: number) {
  SteamClient.Apps.RemoveShortcut(appId);
  appIds.removeAppName(appName);
  artwork.forget(appName);
  logger.debug("Removed a shortcut", { appName, appId });
}

/**
 * Reconcile the Epic library against Steam's shortcuts. Only touches what
 * differs, so running it again once everything is in place is cheap.
 */
export async function sync(games: EpicGame[]): Promise<SyncResult> {
  const result: SyncResult = {
    added: 0,
    removed: 0,
    failed: 0,
    artworkApplied: 0,
    total: games.length,
  };

  if (state.active) {
    logger.debug("A sync is already in progress, skipping this one");
    return result;
  }

  setState({ active: true, done: 0, total: games.length, lastResult: undefined });

  try {
    // Shortcuts the user deleted by hand would otherwise look synced forever.
    appIds.prune(existingShortcutIds());

    const known = appIds.getAll();
    const owned = new Set(games.map((game) => game.appName));

    // Games that left the account - a refund, or a family sharing arrangement
    // ending - leave a shortcut that launches into an ownership error.
    for (const [appName, appId] of Object.entries(known)) {
      if (owned.has(appName)) continue;
      removeShortcut(appName, appId);
      result.removed++;
    }

    let sinceYield = 0;
    let done = 0;
    let addedSinceReindex = 0;

    for (const game of games) {
      const existing = appIds.getAppId(game.appName);
      const appId = existing ?? (await createShortcut(game));

      if (appId === undefined) {
        result.failed++;
      } else {
        if (existing === undefined) {
          result.added++;
          addedSinceReindex++;
        }

        // Also covers shortcuts made by a sync that was interrupted partway.
        if (!artwork.isDone(game.appName)) {
          result.artworkApplied += await artwork.apply(appId, game);
        }
      }

      setState({ done: ++done });

      if (++sinceYield >= BATCH_SIZE) {
        sinceYield = 0;

        // A shortcut Steam knows about but the library doesn't have an appid for
        // yet is, by Steam's reckoning, installed - so everything added during a
        // sync sat in the grid claiming to be until the whole run finished. Once
        // a batch rather than once a run keeps that window to a few games, and
        // costs nothing on the passes that added nothing.
        if (addedSinceReindex > 0) {
          addedSinceReindex = 0;
          library.reindexAppIds();
        }

        await yieldToUi();
      }
    }

    logger.info("Shortcut sync complete", result);
    return result;
  } finally {
    // Not conditional on anything above having succeeded: the appid map has been
    // written to either way, and the library is what every patch reads.
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
  return games.filter((game) => known[game.appName] !== undefined).length;
}
