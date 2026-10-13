import * as appIds from "../state/app-ids";
import { NON_STEAM_APP_APPID_MASK } from "../state/app-ids";

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
    if (app.appid >= NON_STEAM_APP_APPID_MASK) continue;
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

/** Shortcuts of ours, still visible, whose title is also owned on Steam. */
function visibleDuplicates(games: EpicGame[]): number[] {
  const titles = steamTitles();
  const ids: number[] = [];

  for (const game of games) {
    const appId = appIds.getAppId(game.app_name);
    if (appId === undefined || !titles.has(normalize(game.title)) || isHidden(appId)) continue;
    ids.push(appId);
  }

  return ids;
}

const hiddenShortcuts = () => Object.values(appIds.getAll()).filter(isHidden);

/** Hide every Epic shortcut duplicating a Steam game. Returns how many moved. */
export function hideDuplicates(games: EpicGame[]): number {
  const hidden = setHidden(visibleDuplicates(games), true);
  console.info("Hid duplicate Epic shortcuts", { hidden });
  return hidden;
}

/** Unhide every shortcut this plugin created. Returns how many moved. */
export function showAll(): number {
  const shown = setHidden(hiddenShortcuts(), false);
  console.info("Unhid Epic shortcuts", { shown });
  return shown;
}

/** How many duplicates are still visible, for a menu that offers to hide them. */
export const hideableCount = (games: EpicGame[]) => visibleDuplicates(games).length;

/** How many of our shortcuts are hidden, for a menu that offers to show them. */
export const hiddenCount = () => hiddenShortcuts().length;
