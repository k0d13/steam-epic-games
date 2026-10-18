import { type AppAchievement, type AppAchievements } from "millennium";
import * as achievements from "../state/achievements";
import * as library from "../state/library";

// Steam's details page drops most sections for a shortcut:
//
//   e.BIsModOrShortcut() && (s = ["nonsteam", "notes", "screenshots"])
//
// The section itself copes, so backend/patches.lua has that line ask
// `ShortcutSections`, which puts "achievements" back; app-details.ts supplies the data.

interface AppOverview {
  appid: number;
}

/**
 * Epic's "2026-06-12 21:21:24.391000+00:00" has a space where ISO's T goes, so Date
 * can't read it as is.
 */
function unlockedAt(achievement: Achievement): number {
  const parsed = Date.parse(achievement.unlocked_at?.replace(" ", "T") ?? "");
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/** Keyed by the state object, which is replaced whenever a fetch lands. */
const converted = new WeakMap<GameAchievements, AppAchievement[]>();

/**
 * A game's achievements converted for Steam, latest unlock first. Undefined while
 * waiting on Epic; this is what starts the fetch.
 */
function listFor(appName: string): AppAchievement[] | undefined {
  achievements.ensure(appName);

  const result = achievements.get(appName);
  if (!result || result.total === 0) return undefined;

  let list = converted.get(result);
  if (!list) {
    // An empty list arrives as `{}` (Lua has one table type); Object.values reads both.
    list = Object.values(result.achievements)
      .sort((a, b) => unlockedAt(b) - unlockedAt(a))
      .map((achievement): AppAchievement => {
        // Steam draws a bar whenever there's a maximum, so only partly-done ones get one.
        const partial =
          !achievement.unlocked && achievement.progress > 0 && achievement.progress < 1;

        return {
          bAchieved: achievement.unlocked,
          bHidden: achievement.hidden,
          flMinProgress: 0,
          flCurrentProgress: partial ? Math.round(achievement.progress * 100) : 0,
          flMaxProgress: partial ? 100 : 0,
          flAchieved: achievement.rarity ?? 0,
          rtUnlocked: unlockedAt(achievement),
          strDescription: achievement.description,
          strID: achievement.id,
          strImage: achievement.icon ?? "",
          strName: achievement.name,
        };
      });
    converted.set(result, list);
  }

  return list;
}

/** Kept against the converted list, for the same reason `converted` is. */
const bucketed = new WeakMap<AppAchievement[], AppAchievements>();

/** The details store's shape, memoised since a fresh object re-renders every repaint. */
export function getAchievements(appName: string): AppAchievements | undefined {
  const list = listFor(appName);
  const result = achievements.get(appName);
  if (!list || !result) return undefined;

  const cached = bucketed.get(list);
  if (cached) return cached;

  const highlight: AppAchievement[] = [];
  const unachieved: AppAchievement[] = [];
  const achievedHidden: AppAchievement[] = [];

  for (const achievement of list) {
    if (!achievement.bAchieved) unachieved.push(achievement);
    else if (achievement.bHidden) achievedHidden.push(achievement);
    else highlight.push(achievement);
  }

  const built = {
    nAchieved: result.unlocked,
    nTotal: result.total,
    vecHighlight: highlight,
    vecUnachieved: unachieved,
    vecAchievedHidden: achievedHidden,
  };

  bucketed.set(list, built);
  return built;
}

// The full achievements page has its own store, which caches "Failed to retrieve
// user stats" for a shortcut for good, so backend/patches.lua has its three getters
// ask `AchievementStore` first.

/** What the store hands the page: one of these three, never more than one. */
interface StoreResult<T> {
  data?: T;
  loading?: boolean;
  error?: unknown;
}

/** The store's own grouping, keyed by achievement id. */
interface MyAchievements {
  achieved: Record<string, AppAchievement>;
  unachieved: Record<string, AppAchievement>;
  hidden: Record<string, AppAchievement>;
}

/** Just the rarities, which the page shows as "x% of players". */
type GlobalAchievements = Record<string, number>;

/** Memoised groupings. `withHidden` is off for the player page, which has no hidden bucket. */
const grouping = {
  true: new WeakMap<AppAchievement[], MyAchievements>(),
  false: new WeakMap<AppAchievement[], MyAchievements>(),
};

function group(list: AppAchievement[], withHidden: boolean): MyAchievements {
  // The page reads its getters every render, and a big game is hundreds of writes.
  const memo = grouping[withHidden ? "true" : "false"];
  const cached = memo.get(list);
  if (cached) return cached;

  const grouped: MyAchievements = { achieved: {}, unachieved: {}, hidden: {} };

  for (const achievement of list) {
    if (achievement.bAchieved) grouped.achieved[achievement.strID] = achievement;
    else if (withHidden && achievement.bHidden) grouped.hidden[achievement.strID] = achievement;
    else grouped.unachieved[achievement.strID] = achievement;
  }

  memo.set(list, grouped);
  return grouped;
}

/** What each getter answers with, built from our converted list. */
const GETTERS: Record<string, (ours: AppAchievement[]) => unknown> = {
  GetMyAchievements: (ours) => group(ours, true),

  // Epic publishes rarity too, so the page's rarity column is real.
  GetGlobalAchievements: (ours) => {
    const rarities: GlobalAchievements = {};
    for (const achievement of ours) rarities[achievement.strID] = achievement.flAchieved;
    return rarities;
  },

  // Only we can hold an Epic game's achievements, whichever account is asked about.
  GetPlayerAchievements: (ours) => group(ours, false),
};

/**
 * Called from the store's getters, for which undefined means Steam answers. Not yet
 * arrived reads as loading, so the page shows a spinner rather than "no stats" until
 * the repaint brings the answer.
 */
export function AchievementStore(method: string, appId: number): StoreResult<unknown> | undefined {
  const build = GETTERS[method];
  const game = library.getByAppId(appId);
  if (!build || !game) return undefined;

  const ours = listFor(game.app_name);
  return ours ? { data: build(ours) } : { loading: true };
}

/** Called with the sections Steam keeps for a shortcut, before it draws any. */
export function ShortcutSections(overview: AppOverview, sections: string[]): string[] {
  const game = library.getByAppId(overview.appid);
  if (!game || !listFor(game.app_name)) return sections;
  return [...sections, "achievements"];
}
