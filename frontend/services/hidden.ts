import * as appIds from "../state/app-ids";

// Hides Epic shortcuts that duplicate a Steam game. The hiding calls are untyped
// and not on every build, so they're feature tested.

interface Hiding {
  BIsHidden?(appId: number): boolean;
  SetAppsAsHidden?(appIds: number[], hidden: boolean): void;
}

const collections = () => collectionStore as unknown as Hiding;

/**
 * Strip what stores disagree on: punctuation, spacing, case and trademark marks.
 * "S.T.A.L.K.E.R. 2" and "STALKER 2" are the same game.
 */
function normalize(title: string) {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

/** Normalized titles of the real Steam games in the library. */
function steamTitles(): Set<string> {
  const titles = new Set<string>();

  for (const app of appStore.allApps) {
    if (appIds.isShortcut(app.appid)) continue;
    if (app.display_name) titles.add(normalize(app.display_name));
  }

  return titles;
}

function isHidden(appId: number): boolean {
  try {
    return collections().BIsHidden?.(appId) ?? false;
  } catch (reason: unknown) {
    console.warn("Couldn't read whether an app is hidden", { appId, reason });
    return false;
  }
}

/** Hide or unhide shortcuts, preferring the bulk call that writes the collection once. */
function setHidden(ids: number[], hidden: boolean): number {
  if (ids.length === 0) return 0;

  const bulk = collections().SetAppsAsHidden;
  if (bulk) {
    bulk.call(collections(), ids, hidden);
    return ids.length;
  }

  const single = (SteamClient.Apps as { SetAppHidden?(appId: number, hidden: boolean): void })
    .SetAppHidden;
  if (!single) {
    console.warn("This Steam build exposes no way to hide an app");
    return 0;
  }

  for (const appId of ids) single.call(SteamClient.Apps, appId, hidden);
  return ids.length;
}

/** Shortcuts of ours whose title is also owned on Steam, hidden or not as asked. */
function duplicates(games: EpicGame[], hidden: boolean): number[] {
  const titles = steamTitles();
  const ids: number[] = [];

  for (const game of games) {
    const appId = appIds.getAppId(game.app_name);
    if (appId === undefined || !titles.has(normalize(game.title))) continue;
    if (isHidden(appId) === hidden) ids.push(appId);
  }

  return ids;
}

/** Hide every Epic shortcut duplicating a Steam game. Returns how many moved. */
export function hideDuplicates(games: EpicGame[]): number {
  const hidden = setHidden(duplicates(games, false), true);
  console.info("Hid duplicate Epic shortcuts", { hidden });
  return hidden;
}

/** Unhide the duplicates, leaving games hidden for other reasons alone. */
export function showDuplicates(games: EpicGame[]): number {
  const shown = setHidden(duplicates(games, true), false);
  console.info("Unhid duplicate Epic shortcuts", { shown });
  return shown;
}

/** How many of our shortcuts duplicate a Steam game, for the toggle to say. */
export const duplicateCount = (games: EpicGame[]) =>
  duplicates(games, false).length + duplicates(games, true).length;
