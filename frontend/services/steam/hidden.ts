import * as appIds from "../../state/app-ids";

// "S.T.A.L.K.E.R. 2" and "STALKER 2" are the same game, so strip what stores disagree on
function normalize(title: string) {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

// Our shortcuts whose title is also owned on Steam, filtered by hidden state if given
function duplicates(games: EpicGame[], hidden?: boolean) {
  const titles = new Set(
    appStore.allApps
      .filter((app) => !appIds.isShortcut(app.appid))
      .map((app) => normalize(app.display_name)),
  );

  return games.flatMap((game) => {
    const appId = appIds.getAppId(game.app_name);
    if (appId === undefined || !titles.has(normalize(game.title))) return [];
    return hidden === undefined || collectionStore.BIsHidden(appId) === hidden ? [appId] : [];
  });
}

export function setDuplicatesHidden(games: EpicGame[], hidden: boolean) {
  const ids = duplicates(games, !hidden);
  if (ids.length > 0) collectionStore.SetAppsAsHidden(ids, hidden);
}

export function duplicateCount(games: EpicGame[]) {
  return duplicates(games).length;
}
