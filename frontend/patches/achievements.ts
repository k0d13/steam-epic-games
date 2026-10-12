import { afterPatch } from "millennium";
import { findExport } from "../services/modules";
import * as achievements from "../state/achievements";
import * as library from "../state/library";

// Steam's details page drops most sections for a shortcut:
//
//   e.BIsModOrShortcut() && (s = ["nonsteam", "notes", "screenshots"])
//
// The section itself copes, so putting "achievements" back is the whole patch;
// app-details.ts supplies the data.

/** Steam's own achievement shape, as the details store carries it. */
interface SteamAchievement {
  bAchieved: boolean;
  bHidden: boolean;
  flMinProgress: number;
  flCurrentProgress: number;
  flMaxProgress: number;
  flAchieved: number;
  rtUnlocked: number;
  strDescription: string;
  strID: string;
  strImage: string;
  strName: string;
}

export interface SteamAchievements {
  nAchieved: number;
  nTotal: number;
  vecHighlight: SteamAchievement[];
  vecUnachieved: SteamAchievement[];
  vecAchievedHidden: SteamAchievement[];
}

interface AppOverview {
  appid: number;
}

interface SectionsComponent {
  prototype: {
    GetSections(overview: AppOverview, details: unknown): Set<string>;
    /** The Set the last call returned, kept so an unchanged one re-renders as itself. */
    m_setSectionsMemo?: Set<string>;
  };
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
const converted = new WeakMap<GameAchievements, SteamAchievement[]>();

/**
 * A game's achievements converted for Steam, latest unlock first. Undefined while
 * waiting on Epic; this is what starts the fetch.
 */
function listFor(appName: string): SteamAchievement[] | undefined {
  achievements.ensure(appName);

  const result = achievements.get(appName);
  if (!result || result.total === 0) return undefined;

  let list = converted.get(result);
  if (!list) {
    // An empty list arrives as `{}` (Lua has one table type); Object.values reads both.
    list = Object.values(result.achievements)
      .sort((a, b) => unlockedAt(b) - unlockedAt(a))
      .map((achievement): SteamAchievement => {
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
const bucketed = new WeakMap<SteamAchievement[], SteamAchievements>();

/** The details store's shape, memoised since a fresh object re-renders every repaint. */
export function getAchievements(appName: string): SteamAchievements | undefined {
  const list = listFor(appName);
  const result = achievements.get(appName);
  if (!list || !result) return undefined;

  const cached = bucketed.get(list);
  if (cached) return cached;

  const highlight: SteamAchievement[] = [];
  const unachieved: SteamAchievement[] = [];
  const achievedHidden: SteamAchievement[] = [];

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
// user stats" for a shortcut for good, so its three getters are patched instead.

/** What the store hands the page: one of these three, never more than one. */
interface StoreResult<T> {
  data?: T;
  loading?: boolean;
  error?: unknown;
}

/** The store's own grouping, keyed by achievement id. */
interface MyAchievements {
  achieved: Record<string, SteamAchievement>;
  unachieved: Record<string, SteamAchievement>;
  hidden: Record<string, SteamAchievement>;
}

/** Just the rarities, which the page shows as "x% of players". */
type GlobalAchievements = Record<string, number>;

interface AchievementStore {
  GetMyAchievements(appId: number): StoreResult<MyAchievements>;
  GetGlobalAchievements(appId: number): StoreResult<GlobalAchievements>;
  GetPlayerAchievements(appId: number, accountId: number): StoreResult<unknown>;
}

/** Memoised groupings. `withHidden` is off for the player page, which has no hidden bucket. */
const grouping = {
  true: new WeakMap<SteamAchievement[], MyAchievements>(),
  false: new WeakMap<SteamAchievement[], MyAchievements>(),
};

function group(list: SteamAchievement[], withHidden: boolean): MyAchievements {
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

/**
 * Answer a store getter for our games. Not yet arrived reads as loading, so the page
 * shows a spinner rather than "no stats" until the repaint brings the answer.
 */
function patchGetter<T>(
  store: AchievementStore,
  method: keyof AchievementStore,
  build: (ours: SteamAchievement[]) => T,
) {
  // All three share one envelope, so the loosest type stands in for each.
  return afterPatch(store, method as "GetPlayerAchievements", (args, result) => {
    const game = library.getByAppId(args[0]);
    if (!game) return result;

    const ours = listFor(game.app_name);
    return ours ? { data: build(ours) } : { loading: true };
  });
}

function patchStore(store: AchievementStore) {
  const patches = [
    patchGetter(store, "GetMyAchievements", (ours) => group(ours, true)),

    // Epic publishes rarity too, so the page's rarity column is real.
    patchGetter(store, "GetGlobalAchievements", (ours) => {
      const rarities: GlobalAchievements = {};
      for (const achievement of ours) rarities[achievement.strID] = achievement.flAchieved;
      return rarities;
    }),

    // Only we can hold an Epic game's achievements, whichever account is asked about.
    patchGetter(store, "GetPlayerAchievements", (ours) => group(ours, false)),
  ];

  return () => {
    for (const patch of patches) patch.unpatch();
  };
}

export function register() {
  // Found by the "playtestinvites" literal in the same function that drops our section.
  const component = findExport<SectionsComponent>(
    '"playtestinvites"',
    (value): value is SectionsComponent =>
      typeof value === "function" &&
      typeof (value as SectionsComponent).prototype?.GetSections === "function",
  );
  if (!component) {
    console.warn("Could not find the app details sections component, achievements stay hidden");
    return () => {};
  }

  const patch = afterPatch(
    component.prototype,
    "GetSections",
    function (this: SectionsComponent["prototype"], args, sections: Set<string>) {
      const [overview] = args as [AppOverview, unknown];

      const game = library.getByAppId(overview.appid);
      if (!game || !listFor(game.app_name)) return sections;

      sections.add("achievements");
      // The component returns its memoised Set when the new one matches, which
      // would discard our edit on the next render.
      this.m_setSectionsMemo = sections;
      return sections;
    },
  );

  // Optional: without the store the section still draws, it just leads nowhere.
  // Found by the warning it logs for every shortcut.
  const store = findExport<AchievementStore>(
    "Failed to GetMyAchievementsForApp",
    (value): value is AchievementStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as AchievementStore).GetMyAchievements === "function" &&
      typeof (value as AchievementStore).GetGlobalAchievements === "function",
  );
  if (!store) console.warn("Could not find the achievement store, the full page stays empty");
  const unpatchStore = store ? patchStore(store) : () => {};

  console.debug("Registered the achievements patch");

  return () => {
    patch.unpatch();
    unpatchStore();
  };
}
