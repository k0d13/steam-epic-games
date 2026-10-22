import * as appIds from "./app-ids";
import { createSignal, createStore } from "./primitives";

// The backend's library in memory, so Steam's render path can ask synchronously

const byAppName = new Map<string, EpicGame>();
const byAppId = new Map<number, EpicGame>();

const changed = createSignal();
export const subscribe = changed.subscribe;

let latest: Library | undefined;
export function getLatest() {
  return latest;
}

// Each game's last installed build, so an update from anywhere, the Epic launcher
// included, is noticed and whatever was cached for the old build is dropped
const versions = createStore<string>("epic-games:versions:v1");

const updated = createSignal<EpicGame>();
export const onUpdated = updated.subscribe;

function reindex(games: EpicGame[]) {
  byAppName.clear();
  byAppId.clear();
  const newBuilds: EpicGame[] = [];

  for (const game of games) {
    byAppName.set(game.app_name, game);
    const appId = appIds.getAppId(game.app_name);
    if (appId !== undefined) byAppId.set(appId, game);

    // Kept through an uninstall, so reinstalling a newer build counts too
    if (!game.version) continue;
    const previous = versions.get(game.app_name);
    if (previous === game.version) continue;
    versions.set(game.app_name, game.version);
    // The first sighting has nothing cached to be stale
    if (previous !== undefined) newBuilds.push(game);
  }

  changed.emit();
  for (const game of newBuilds) updated.emit(game);
}

export function reindexAppIds() {
  return reindex([...byAppName.values()]);
}

export function getByAppId(appId: number) {
  return byAppId.get(appId);
}
export function appIdsWithGames() {
  return [...byAppId.keys()];
}

async function read(request: Promise<Library>, failure: string) {
  // Lua sends {} for an empty list
  const raw = await request;
  const games = Object.values(raw.games).map((game) => ({
    ...game,
    dlcs: Object.values(game.dlcs ?? {}),
  }));
  const result: Library = { ...raw, games };
  if (result.error) console.error(failure, result.error);

  latest = result;
  reindex(result.games);
  return result;
}

// Two refreshes at once ran `legendary list` side by side, failing one and slowing
// the other to minutes, so a second caller shares the first
let refreshing: Promise<Library> | undefined;

export function load(refresh = false, force = false) {
  const failure = "Failed to load the Epic library";
  if (!refresh) return read(backend.GetLibrary(false, false), failure);

  refreshing ??= read(backend.GetLibrary(true, force), failure).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

// For an install or uninstall finishing, without asking Epic
export function loadInstalled() {
  return read(backend.GetInstalled(), "Failed to re-read the installed games");
}
