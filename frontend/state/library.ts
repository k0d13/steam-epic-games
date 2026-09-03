import { logger } from "../index";
import rpc, { type EpicGame } from "../rpc";
import * as appIds from "./app-ids";
import { createEmitter } from "./emitter";

// An in-memory mirror of the backend's library, indexed by both keys. The
// install state patch runs inside Steam's render path, so "is this one of ours?"
// has to be answered synchronously.

const byAppName = new Map<string, EpicGame>();
const byAppId = new Map<number, EpicGame>();

/** Fires whenever the library changes, so anything showing it can repaint. */
const emitter = createEmitter();
export const subscribe = emitter.subscribe;

function reindex(games: EpicGame[]) {
  byAppName.clear();
  byAppId.clear();

  for (const game of games) {
    byAppName.set(game.appName, game);
    const appId = appIds.getAppId(game.appName);
    if (appId !== undefined) byAppId.set(appId, game);
  }

  emitter.emit();
}

/** Re-read the appid mapping without refetching the library from the backend. */
export function reindexAppIds() {
  reindex([...byAppName.values()]);
}

export function getByAppId(appId: number): EpicGame | undefined {
  return byAppId.get(appId);
}

/**
 * Load the library from the backend, from its cache unless `refresh` is set -
 * reading it fresh takes several seconds.
 */
export async function load(refresh = false, force = false) {
  const result = await rpc.GetLibrary(refresh, force);

  if (!result.ok) {
    logger.error("Failed to load the Epic library", result.error);
    return result;
  }

  reindex(result.games);
  logger.debug("Loaded the Epic library", { games: result.games.length, refresh });

  return result;
}

/**
 * Re-read what's installed on disk and repaint, for an install or uninstall
 * finishing. The catalog can't have changed, so this skips the trip to Epic.
 */
export async function loadInstalled() {
  const result = await rpc.GetInstalled();

  if (!result.ok) {
    logger.warn("Failed to re-read the installed games", result.error);
    return result;
  }

  reindex(result.games);
  return result;
}

/** Whether anything is signed in, for the paths that cost nothing to skip. */
export function isEmpty(): boolean {
  return byAppName.size === 0;
}

/** The Steam appids we have shortcuts for, for the paths that correct them. */
export function appIdsWithGames(): number[] {
  return [...byAppId.keys()];
}
