import { NON_STEAM_APP_APPID_MASK, Steam } from "steambrew-utils";
import { logger } from "../index";
import { type EpicGame } from "../rpc";
import * as appIds from "../state/app-ids";

// Owning a game on both stores puts it in the library twice. Steam's own answer
// is the per-game "Hide this game", so that's what this drives - in bulk, over
// the Epic shortcuts whose title already belongs to a real Steam game.
//
// Neither hiding call is in steambrew-utils' types and neither exists on every
// client build, so both are found by feature test and a missing one costs only
// this feature.

interface Hiding {
  BIsHidden?(appId: number): boolean;
  SetAppsAsHidden?(appIds: number[], hidden: boolean): void;
}

const collections = () => Steam.CollectionStore as unknown as Hiding;

/**
 * Titles compared with everything a store could disagree about removed:
 * punctuation, spacing, case and the trademark marks Steam keeps and Epic
 * doesn't. "S.T.A.L.K.E.R. 2" and "STALKER 2" are the same game.
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

  for (const app of Steam.AppStore.allApps) {
    if (app.appid >= NON_STEAM_APP_APPID_MASK) continue;
    if (app.display_name) titles.add(normalize(app.display_name));
  }

  return titles;
}

export interface Duplicate {
  game: EpicGame;
  appId: number;
}

/** Epic games with a shortcut whose title is also owned on Steam. */
export function findDuplicates(games: EpicGame[]): Duplicate[] {
  const titles = steamTitles();
  const duplicates: Duplicate[] = [];

  for (const game of games) {
    const appId = appIds.getAppId(game.appName);
    if (appId === undefined || !titles.has(normalize(game.title))) continue;
    duplicates.push({ game, appId });
  }

  return duplicates;
}

export function isHidden(appId: number): boolean {
  try {
    return collections().BIsHidden?.(appId) ?? false;
  } catch (reason: unknown) {
    logger.warn("Couldn't read whether an app is hidden", { appId, reason });
    return false;
  }
}

/**
 * Hide or unhide shortcuts, preferring the store's bulk call - it writes the
 * hidden collection once rather than per game.
 */
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
    logger.warn("This Steam build exposes no way to hide an app");
    return 0;
  }

  for (const appId of ids) single.call(SteamClient.Apps, appId, hidden);
  return ids.length;
}

/** Hide every Epic shortcut duplicating a Steam game. Returns how many moved. */
export function hideDuplicates(games: EpicGame[]): number {
  const ids = findDuplicates(games)
    .map(({ appId }) => appId)
    .filter((appId) => !isHidden(appId));

  const hidden = setHidden(ids, true);
  logger.info("Hid duplicate Epic shortcuts", { hidden });
  return hidden;
}

/** Unhide every shortcut this plugin created. Returns how many moved. */
export function showAll(): number {
  const ids = Object.values(appIds.getAll()).filter((appId) => isHidden(appId));

  const shown = setHidden(ids, false);
  logger.info("Unhid Epic shortcuts", { shown });
  return shown;
}

/** How many duplicates are still visible, for a menu that offers to hide them. */
export function hideableCount(games: EpicGame[]): number {
  return findDuplicates(games).filter(({ appId }) => !isHidden(appId)).length;
}

/** How many of our shortcuts are hidden, for a menu that offers to show them. */
export function hiddenCount(): number {
  return Object.values(appIds.getAll()).filter(isHidden).length;
}
