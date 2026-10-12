import { type SteamAppOverview } from "millennium";
import * as appIds from "./app-ids";
import { createEmitter } from "./emitter";

// The backend's library in memory, so Steam's render path can ask synchronously.

const byAppName = new Map<string, EpicGame>();
const byAppId = new Map<number, EpicGame>();

/** Fires whenever the library changes, so anything showing it can repaint. */
const emitter = createEmitter();
export const subscribe = emitter.subscribe;

function reindex(games: EpicGame[]) {
  byAppName.clear();
  byAppId.clear();

  for (const game of games) {
    byAppName.set(game.app_name, game);
    const appId = appIds.getAppId(game.app_name);
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

/** An empty list arrives as `{}` (Lua has one table type); Object.values reads both. */
const withGames = (library: Library): Library => ({
  ...library,
  games: Object.values(library.games),
});

/** Load the library, from the backend's cache unless `refresh` is set. */
export async function load(refresh = false, force = false) {
  const result = withGames(await backend.get_library(refresh, force));
  if (result.error) console.error("Failed to load the Epic library", result.error);

  reindex(result.games);
  return result;
}

/** Re-read installs without asking Epic, for an install or uninstall finishing. */
export async function loadInstalled() {
  const result = withGames(await backend.get_installed());
  if (result.error) console.warn("Failed to re-read the installed games", result.error);

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

/**
 * Steam's overviews for our shortcuts, by appid: this runs on every change and
 * `allApps` holds thousands.
 */
export function overviews(): SteamAppOverview[] {
  return appIdsWithGames()
    .map((appId) => appStore.GetAppOverviewByAppID(appId))
    .filter((app): app is SteamAppOverview => app !== undefined);
}
