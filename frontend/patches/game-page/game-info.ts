import { searchURL } from "../../services/epic/store";
import * as achievements from "../../state/achievements";
import * as info from "../../state/info";
import * as library from "../../state/library";
import { hasAchievements } from "./achievements";

// Steam's details page drops most sections for a shortcut:
//
//   e.BIsModOrShortcut() && (s = ["nonsteam", "notes", "screenshots"])
//
// backend/patches.lua has that line ask `ShortcutSections`, which swaps the "nonsteam"
// placeholder for the info panel and puts "achievements" back. The panel and the button
// that open it are guarded by the same check, so both ask `HasGameInfo` first. Beyond
// that they're Steam's own: they read the app data store, which we fill the way Steam
// does from the store's reply, and the overview, which overviews completes. The bar of
// links under the play bar is empty for a shortcut too, so `ShortcutLinks` fills it

interface AppOverview {
  appid: number;
}

// Steam's store category ids, which its feature list and filters read
const CATEGORY = {
  multiPlayer: 1,
  singlePlayer: 2,
  coOp: 9,
  achievements: 22,
  cloudSaves: 23,
  fullController: 28,
} as const;

// egdata's tags and features that Steam has a category for. Epic doesn't say how much of
// a game a controller covers, so its support counts as full
const TAG_CATEGORIES: Record<string, number> = {
  "Single Player": CATEGORY.singlePlayer,
  Multiplayer: CATEGORY.multiPlayer,
  "Online Multiplayer": CATEGORY.multiPlayer,
  "Co-op": CATEGORY.coOp,
  "Controller Support": CATEGORY.fullController,
  Achievements: CATEGORY.achievements,
  "Cloud Saves": CATEGORY.cloudSaves,
};

// Steam's store tag ids, which its genre and tag filters and dynamic collections read,
// for each of egdata's genres
const GENRE_TAGS: Record<string, number> = {
  Action: 19,
  Adventure: 21,
  "Action-Adventure": 4106,
  Strategy: 9,
  RPG: 122,
  Simulation: 599,
  Casual: 597,
  Indie: 492,
  Sports: 701,
  Racing: 699,
  Music: 1621,
  Platformer: 1625,
  "Tower Defense": 1645,
  Survival: 1662,
  Puzzle: 1664,
  "Card Game": 1666,
  Horror: 1667,
  RTS: 1676,
  "Turn-Based": 1677,
  Fantasy: 1684,
  Stealth: 1687,
  "Open World": 1695,
  "Rogue-Lite": 3959,
  MOBA: 1718,
  Comedy: 1719,
  "Dungeon Crawler": 1720,
  "Turn-Based Strategy": 1741,
  Narration: 1742,
  Fighting: 1743,
  Rhythm: 1752,
  Space: 1755,
  Shooter: 1774,
  Exploration: 3834,
  "First Person": 3839,
  Retro: 4004,
  "City Builder": 4328,
  Party: 7178,
  Trivia: 10437,
};

const SUPPORT_LINK = { label: "Support", url: "https://www.epicgames.com/help" };

// Shared with the library's filters; achievements count from a tag, or once read, since
// this runs for every game
export function categoriesFor(appName: string) {
  const details = info.get(appName);
  if (!details) return [];

  // Lua sends {} for an empty list; Object.values reads both
  const categories = new Set(
    Object.values(details.tags).flatMap((tag) => TAG_CATEGORIES[tag] ?? []),
  );
  if (details.cloud_saves) categories.add(CATEGORY.cloudSaves);
  if ((achievements.getSummary(appName)?.total ?? 0) > 0) categories.add(CATEGORY.achievements);
  return [...categories];
}

// The store tags the library filters genres by
export function storeTagsFor(appName: string) {
  // Lua sends {} for an empty list; Object.values reads both
  return Object.values(info.get(appName)?.genres ?? []).flatMap((genre) => GENRE_TAGS[genre] ?? []);
}

// Info already in the app data store; Steam asks the store's website for what it lacks,
// and for a shortcut that answer would overwrite ours, so the panel waits for this
const published = new WeakSet<GameInfo>();

// Each name links to Epic's search for it, as Steam's link to its own
function associations(names: string[]) {
  return Object.values(names).map((name) => ({ strName: name, strURL: searchURL(name) }));
}

function publish(appId: number) {
  const game = library.getByAppId(appId);
  const details = game && info.get(game.app_name);
  if (!details) return false;
  if (published.has(details)) return true;

  const store = globalThis.appDetailsStore;
  if (!store) return false;

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

function isAvailable(appId: number) {
  const game = library.getByAppId(appId);
  if (!game) return false;

  info.ensure(game.app_name);
  // Info kept from an earlier session is there already, and so is published now
  return publish(appId);
}

export function register() {
  // Ahead of the repaint index subscribes, so what it draws already has the data
  return info.subscribe(() => {
    for (const appId of library.appIdsWithGames()) publish(appId);
  });
}

// False leaves Steam's shortcut behaviour
export function HasGameInfo(overview: AppOverview) {
  return isAvailable(overview.appid);
}

// Asked as the page is built, before info is known, to start the panel closed like a Steam game's
export function IsEpicGame(overview: AppOverview) {
  return library.getByAppId(overview.appid) !== undefined;
}

export function ShortcutSections(overview: AppOverview, sections: string[]) {
  const game = library.getByAppId(overview.appid);
  if (!game) return sections;

  // The placeholder says Steam has no details, which stops being the case
  const result = isAvailable(overview.appid)
    ? [...sections.filter((section) => section !== "nonsteam"), "info"]
    : [...sections];
  if (hasAchievements(game.app_name)) result.push("achievements");
  return result;
}

// The links the backend found for the game, which only has those Epic has, and Support
export function ShortcutLinks(overview: AppOverview) {
  const game = library.getByAppId(overview.appid);
  // Lua sends {} for an empty list; Object.values reads both
  return game ? [...Object.values(info.get(game.app_name)?.links ?? []), SUPPORT_LINK] : [];
}
