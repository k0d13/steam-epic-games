import * as appIds from "./app-ids";
import { createSignal, createStore } from "./primitives";

// The backend's library in memory, so Steam's render path can ask synchronously.

const byAppName = new Map<string, EpicGame>();
const byAppId = new Map<number, EpicGame>();

/** Fires whenever the library changes, so anything showing it can repaint. */
const changed = createSignal();
export const subscribe = changed.subscribe;

/** The last library read, for anything showing it outside the read's caller. */
let latest: Library | undefined;

export function getLatest(): Library | undefined {
  return latest;
}

// Each game's last installed build, so an update from anywhere, the Epic launcher
// included, is noticed and whatever was cached for the old build is dropped.
const versions = createStore<string>("epic-games:versions:v1");

const updated = createSignal<EpicGame>();

/** Hear a game whose installed build changed since we last saw it. */
export const onUpdated = updated.subscribe;

function reindex(games: EpicGame[]) {
  byAppName.clear();
  byAppId.clear();
  const newBuilds: EpicGame[] = [];

  for (const game of games) {
    byAppName.set(game.app_name, game);
    const appId = appIds.getAppId(game.app_name);
    if (appId !== undefined) byAppId.set(appId, game);

    // Kept through an uninstall, so reinstalling a newer build counts too.
    if (!game.version) continue;
    const previous = versions.get(game.app_name);
    if (previous === game.version) continue;
    versions.set(game.app_name, game.version);
    // The first sighting has nothing cached to be stale.
    if (previous !== undefined) newBuilds.push(game);
  }

  changed.emit();
  for (const game of newBuilds) updated.emit(game);
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

/**
 * A refresh still running. Two at once ran `legendary list` side by side, which
 * failed one and slowed the other to minutes, so a second caller shares it.
 */
let refreshing: Promise<Library> | undefined;

/** Load the library, from the backend's cache unless `refresh` is set. */
export function load(refresh = false, force = false): Promise<Library> {
  if (!refresh) return read(false, false);

  refreshing ??= read(true, force).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function read(refresh: boolean, force: boolean): Promise<Library> {
  const result = withGames(await backend.GetLibrary(refresh, force));
  if (result.error) console.error("Failed to load the Epic library", result.error);

  latest = result;
  reindex(result.games);
  return result;
}

/** Re-read installs without asking Epic, for an install or uninstall finishing. */
export async function loadInstalled() {
  const result = withGames(await backend.GetInstalled());
  if (result.error) console.warn("Failed to re-read the installed games", result.error);

  latest = result;
  reindex(result.games);
  return result;
}

/** The Steam appids we have shortcuts for, for the paths that correct them. */
export function appIdsWithGames(): number[] {
  return [...byAppId.keys()];
}
