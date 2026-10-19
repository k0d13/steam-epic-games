import * as achievements from "../state/achievements";
import * as info from "../state/info";
import * as library from "../state/library";
import { hasAchievements } from "./achievements";
import { searchURL } from "./store-menu";

// Steam's details page drops most sections for a shortcut:
//
//   e.BIsModOrShortcut() && (s = ["nonsteam", "notes", "screenshots"])
//
// backend/patches.lua has that line ask `ShortcutSections`, which swaps the
// "nonsteam" placeholder for the info panel and puts "achievements" back. The panel
// and the button that opens it are guarded by the same check, so both ask
// `HasGameInfo` first. Beyond that they're Steam's own: they read the app data
// store, which we fill the way Steam does from the store's reply, and the overview,
// which overviews.ts completes. The bar of links under the play bar is empty for a
// shortcut too, so `ShortcutLinks` fills it with Epic's equivalents.

interface AppOverview {
  appid: number;
}

/** Steam's store category ids, which its feature list and filters read. */
const CATEGORY = {
  multiPlayer: 1,
  singlePlayer: 2,
  coOp: 9,
  achievements: 22,
  cloudSaves: 23,
} as const;

/** Epic's tags that say how a game is played, and the category each is. */
const MODE_TAGS: Record<string, number> = {
  SINGLE_PLAYER: CATEGORY.singlePlayer,
  MULTIPLAYER: CATEGORY.multiPlayer,
  CO_OP: CATEGORY.coOp,
};

/**
 * The feature list's categories for a game, which its filters share. Achievements
 * are only counted once read, since this runs for every game.
 */
export function categoriesFor(appName: string): number[] {
  const details = info.get(appName);
  if (!details) return [];

  // An empty list arrives as `{}` (Lua has one table type); Object.values reads both.
  const categories = Object.values(details.tags).flatMap((tag) => MODE_TAGS[tag] ?? []);
  if (details.cloud_saves) categories.push(CATEGORY.cloudSaves);
  if ((achievements.getSummary(appName)?.total ?? 0) > 0) categories.push(CATEGORY.achievements);
  return categories;
}

/**
 * Info that is in the app data store. Steam asks the store's website for what it
 * lacks, and for a shortcut that answer would overwrite ours, so the panel waits
 * for this.
 */
const published = new WeakSet<GameInfo>();

/** Put one game's info where the panel reads it, if it hasn't been already. */
function publish(appId: number): boolean {
  const game = library.getByAppId(appId);
  const details = game && info.get(game.app_name);
  if (!details) return false;
  if (published.has(details)) return true;

  const store = globalThis.appDetailsStore;
  if (!store) return false;

  // Each name links to Epic's search for it, as Steam's link to its own.
  const associations = (names: string[]) =>
    Object.values(names).map((name) => ({ strName: name, strURL: searchURL(name) }));

  const data = store.GetAppData(appId);
  data.associationData = {
    rgDevelopers: associations(details.developers),
    rgPublishers: associations(details.publishers),
    rgFranchises: [],
  };
  data.descriptionsData = {
    strFullDescription: details.description,
    strSnippet: details.description,
  };
  published.add(details);
  return true;
}

export function register() {
  // Ahead of the repaint index.tsx subscribes, so what it draws already has the data.
  return info.subscribe(() => {
    for (const appId of library.appIdsWithGames()) publish(appId);
  });
}

/** Is there an info panel to show for this game? Starts reading it if not yet. */
function isAvailable(appId: number): boolean {
  const game = library.getByAppId(appId);
  if (!game) return false;

  info.ensure(game.app_name);
  // Info kept from an earlier session is there already, and so is published now.
  return publish(appId);
}

/** Called from the panel and its button, for which false leaves Steam's shortcut behaviour. */
export function HasGameInfo(overview: AppOverview): boolean {
  return isAvailable(overview.appid);
}

/** Called as the page is built, before info is known, to start the panel closed like a Steam game's. */
export function IsEpicGame(overview: AppOverview): boolean {
  return library.getByAppId(overview.appid) !== undefined;
}

/** Called with the sections Steam keeps for a shortcut, before it draws any. */
export function ShortcutSections(overview: AppOverview, sections: string[]): string[] {
  const game = library.getByAppId(overview.appid);
  if (!game) return sections;

  // The placeholder says Steam has no details, which stops being the case.
  const result = isAvailable(overview.appid)
    ? [...sections.filter((section) => section !== "nonsteam"), "info"]
    : [...sections];
  if (hasAchievements(game.app_name)) result.push("achievements");
  return result;
}

/** Epic's help centre, which isn't about any one game. */
const SUPPORT_LINK = { label: "Support", url: "https://www.epicgames.com/help" };

/**
 * Called with a shortcut's overview, for the links Steam leaves out of its bar: the
 * ones the backend found for the game, which only has those Epic has, and Support.
 */
export function ShortcutLinks(overview: AppOverview): GameLink[] {
  const game = library.getByAppId(overview.appid);
  // An empty list arrives as `{}` (Lua has one table type); Object.values reads both.
  return game ? [...Object.values(info.get(game.app_name)?.links ?? []), SUPPORT_LINK] : [];
}
