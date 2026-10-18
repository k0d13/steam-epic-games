import * as appIds from "../state/app-ids";

// Hides Epic shortcuts that duplicate a Steam game.

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

/** Shortcuts of ours whose title is also owned on Steam, hidden or not if asked. */
function duplicates(games: EpicGame[], hidden?: boolean): number[] {
  const titles = new Set(
    appStore.allApps
      .filter((app) => !appIds.isShortcut(app.appid))
      .map((app) => normalize(app.display_name)),
  );

  const ids: number[] = [];
  for (const game of games) {
    const appId = appIds.getAppId(game.app_name);
    if (appId === undefined || !titles.has(normalize(game.title))) continue;
    if (hidden === undefined || collectionStore.BIsHidden(appId) === hidden) ids.push(appId);
  }
  return ids;
}

/** Hide every Epic shortcut duplicating a Steam game, or unhide just those. */
export function setDuplicatesHidden(games: EpicGame[], hidden: boolean) {
  const ids = duplicates(games, !hidden);
  if (ids.length > 0) collectionStore.SetAppsAsHidden(ids, hidden);
}

/** How many of our shortcuts duplicate a Steam game, for the toggle to say. */
export const duplicateCount = (games: EpicGame[]) => duplicates(games).length;
