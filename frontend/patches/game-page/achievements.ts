import { type AppAchievement, type AppAchievements, callOriginal, replacePatch } from "millennium";
import * as achievements from "../../state/game/achievements";
import * as library from "../../state/library";

// game-info puts back the achievements section Steam drops for a shortcut, and
// app-details supplies the data

// Epic's "2026-06-12 21:21:24.391000+00:00" has a space where ISO's T goes
function unlockedAt(achievement: Achievement) {
  const parsed = Date.parse(achievement.unlocked_at?.replace(" ", "T") ?? "");
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function convert(achievement: Achievement) {
  // Steam draws a bar whenever there's a maximum, so only partly-done ones get one
  const partial = !achievement.unlocked && achievement.progress > 0 && achievement.progress < 1;

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
}

// Keyed by the state object, which is replaced whenever a fetch lands
const converted = new WeakMap<GameAchievements, AppAchievement[]>();

// Latest unlock first; undefined while waiting on Epic, and what starts the fetch
export function listFor(appName: string) {
  achievements.ensure(appName);

  const result = achievements.get(appName);
  if (!result || result.total === 0) return undefined;

  let list = converted.get(result);
  if (!list) {
    // Lua sends {} for an empty list
    list = Object.values(result.achievements)
      .sort((a, b) => unlockedAt(b) - unlockedAt(a))
      .map(convert);
    converted.set(result, list);
  }

  return list;
}

export function hasAchievements(appName: string) {
  return listFor(appName) !== undefined;
}

// Memoised against the converted list, as a fresh object re-renders every repaint
const bucketed = new WeakMap<AppAchievement[], AppAchievements>();

export function getAchievements(appName: string) {
  const list = listFor(appName);
  const result = achievements.get(appName);
  if (!list || !result) return undefined;

  const cached = bucketed.get(list);
  if (cached) return cached;

  const built: AppAchievements = {
    nAchieved: result.unlocked,
    nTotal: result.total,
    vecHighlight: list.filter((a) => a.bAchieved && !a.bHidden),
    vecUnachieved: list.filter((a) => !a.bAchieved),
    vecAchievedHidden: list.filter((a) => a.bAchieved && a.bHidden),
  };

  bucketed.set(list, built);
  return built;
}

// The full achievements page caches "Failed to retrieve user stats" for a shortcut for
// good, so backend/patches.lua has its store's getters ask `AchievementStore` first

// The store's own grouping, keyed by achievement id
interface Grouped {
  achieved: Record<string, AppAchievement>;
  unachieved: Record<string, AppAchievement>;
  hidden: Record<string, AppAchievement>;
}

// Separate memos per mode, as the page reads its getters every render and a big game
// is hundreds of writes
const groupings = {
  withHidden: new WeakMap<AppAchievement[], Grouped>(),
  withoutHidden: new WeakMap<AppAchievement[], Grouped>(),
};

// The player page has no hidden bucket
function group(list: AppAchievement[], withHidden: boolean) {
  const memo = withHidden ? groupings.withHidden : groupings.withoutHidden;
  const cached = memo.get(list);
  if (cached) return cached;

  const grouped: Grouped = { achieved: {}, unachieved: {}, hidden: {} };

  for (const achievement of list) {
    if (achievement.bAchieved) grouped.achieved[achievement.strID] = achievement;
    else if (withHidden && achievement.bHidden) grouped.hidden[achievement.strID] = achievement;
    else grouped.unachieved[achievement.strID] = achievement;
  }

  memo.set(list, grouped);
  return grouped;
}

const GETTERS: Record<string, (ours: AppAchievement[]) => unknown> = {
  GetMyAchievements: (ours) => group(ours, true),

  // Epic publishes rarity too, so the page's rarity column is real
  GetGlobalAchievements: (ours) =>
    Object.fromEntries(ours.map((achievement) => [achievement.strID, achievement.flAchieved])),

  // Only we can hold an Epic game's achievements, whichever account is asked about
  GetPlayerAchievements: (ours) => group(ours, false),
};

// Undefined means Steam answers; not yet arrived reads as loading, so the page shows
// a spinner rather than "no stats" until the repaint brings the answer
export function AchievementStore(method: string, appId: number) {
  const build = GETTERS[method];
  const game = library.getByAppId(appId);
  if (!build || !game) return undefined;

  const ours = listFor(game.app_name);
  return ours ? { data: build(ours) } : { loading: true };
}

// The completion sort reads appAchievementProgressCache, filled from Steam's CM, which
// knows nothing of shortcuts
export function register() {
  const cache = globalThis.appAchievementProgressCache;
  if (!cache) {
    console.warn("Could not find the achievement progress cache, the completion sort stays empty");
    return () => {};
  }

  const patches = [
    // Steam defaults unknown appids to true, so uncached games would sort as 0%
    replacePatch(cache, "BGameHasAchievements", ([appId]: [number]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as boolean;

      return (achievements.getSummary(game.app_name)?.total ?? 0) > 0;
    }),

    // Never fetches, as this runs per game on every library render
    replacePatch(cache, "GetAchievementProgress", ([appId]: [number]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as number;

      const summary = achievements.getSummary(game.app_name);
      return summary?.total ? Math.round((summary.unlocked / summary.total) * 100) : 0;
    }),
  ];

  return () => patches.forEach((patch) => patch.unpatch());
}
