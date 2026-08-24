import { afterPatch } from "@steambrew/client";
import { logger } from "../index";
import { type Achievement, type GameAchievements } from "../rpc";
import { findExport } from "../services/modules";
import * as achievements from "../state/achievements";
import * as library from "../state/library";

// Steam's app details page builds the list of sections it will draw, and throws
// nearly all of them away for a shortcut:
//
//   e.BIsModOrShortcut() && (s = ["nonsteam", "notes", "screenshots"])
//
// So the achievements section never mounts for an Epic game, however good the
// data behind it is. The section component itself has no such opinion - it only
// asks appDetailsStore for the achievements and returns null if there are none -
// which makes putting "achievements" back into that set the whole patch.
//
// The details themselves are filled in by app-details.ts, on the same callback
// it already corrects the install state through.

/** Steam's own achievement shape, as the details store carries it. */
export interface SteamAchievement {
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
 * Epic tracks progress on a handful of achievements and leaves the rest at 0 or
 * 1. Steam draws a progress bar whenever there's a maximum, so one is only
 * given to the partly-done ones - everything else is a plain locked icon.
 */
function toSteamAchievement(achievement: Achievement): SteamAchievement {
  const partial = !achievement.unlocked && achievement.progress > 0 && achievement.progress < 1;

  return {
    bAchieved: achievement.unlocked,
    bHidden: achievement.hidden,
    flMinProgress: 0,
    flCurrentProgress: partial ? Math.round(achievement.progress * 100) : 0,
    flMaxProgress: partial ? 100 : 0,
    flAchieved: achievement.rarity ?? 0,
    rtUnlocked: achievement.unlockedAt ?? 0,
    strDescription: achievement.description,
    strID: achievement.id,
    strImage: achievement.icon ?? "",
    strName: achievement.name,
  };
}

/**
 * Kept against the state object it was built from: the render paths below ask
 * for a game's achievements several times a page, and the answer only changes
 * when a fetch lands, which is a new object.
 */
const converted = new WeakMap<GameAchievements, SteamAchievement[]>();

/**
 * One game's achievements, converted and sorted the way Steam features them -
 * most recent unlock first. Undefined while we're still waiting on Epic; the
 * fetch starts here, so a details page opening is what asks.
 */
function listFor(appName: string): SteamAchievement[] | undefined {
  achievements.ensure(appName);

  const result = achievements.get(appName);
  if (!result || result.total === 0) return undefined;

  let list = converted.get(result);
  if (!list) {
    list = [...result.achievements]
      .sort((a, b) => (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0))
      .map(toSteamAchievement);
    converted.set(result, list);
  }

  return list;
}

/** One game's achievements in the shape the app details store holds. */
export function getAchievements(appName: string): SteamAchievements | undefined {
  const list = listFor(appName);
  const result = achievements.get(appName);
  if (!list || !result) return undefined;

  const highlight: SteamAchievement[] = [];
  const unachieved: SteamAchievement[] = [];
  const achievedHidden: SteamAchievement[] = [];

  for (const achievement of list) {
    if (!achievement.bAchieved) unachieved.push(achievement);
    else if (achievement.bHidden) achievedHidden.push(achievement);
    else highlight.push(achievement);
  }

  return {
    nAchieved: result.unlocked,
    nTotal: result.total,
    vecHighlight: highlight,
    vecUnachieved: unachieved,
    vecAchievedHidden: achievedHidden,
  };
}

// The full achievements page - the one "View all achievements" opens - reads
// none of that. It goes through a store of its own, which asks the client for
// the account's stats and caches the answer, error included: a shortcut has no
// stats, so it caches "Failed to retrieve user stats" once and never asks
// again. Patching the client call underneath it therefore isn't enough; the
// store's three getters are what the page actually reads.

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

/** Every achievement of ours for an appid, or undefined for anything else. */
function forAppId(appId: number): SteamAchievement[] | undefined {
  const game = library.getByAppId(appId);
  return game ? listFor(game.appName) : undefined;
}

/**
 * The app details page component. Found by the section names it lists rather
 * than by anything Steam's build could rename - "playtestinvites" is a string
 * literal in the same function that drops our section.
 */
function findSectionsComponent(): SectionsComponent | undefined {
  return findExport<SectionsComponent>(
    '"playtestinvites"',
    (value): value is SectionsComponent =>
      typeof value === "function" &&
      typeof (value as SectionsComponent).prototype?.GetSections === "function",
  );
}

/**
 * The store behind the achievements page, found by the warning it logs when the
 * client refuses a game's stats - which is the very thing it does for every
 * shortcut.
 */
function findAchievementStore(): AchievementStore | undefined {
  return findExport<AchievementStore>(
    "Failed to GetMyAchievementsForApp",
    (value): value is AchievementStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as AchievementStore).GetMyAchievements === "function" &&
      typeof (value as AchievementStore).GetGlobalAchievements === "function",
  );
}

/**
 * The store's grouping. `withHidden` is off for the player page, which has no
 * hidden bucket of its own - a locked hidden achievement is only locked there.
 */
function group(list: SteamAchievement[], withHidden: boolean): MyAchievements {
  const grouped: MyAchievements = { achieved: {}, unachieved: {}, hidden: {} };

  for (const achievement of list) {
    if (achievement.bAchieved) grouped.achieved[achievement.strID] = achievement;
    else if (withHidden && achievement.bHidden) grouped.hidden[achievement.strID] = achievement;
    else grouped.unachieved[achievement.strID] = achievement;
  }

  return grouped;
}

/**
 * Answer one of the store's getters out of our own state, for our own games
 * only.
 *
 * A game whose achievements haven't arrived yet reads as loading rather than as
 * an error, so the page shows its spinner and not "no stats" - `forAppId` has
 * started the fetch by then, and the repaint on arrival brings the answer.
 */
function patchGetter<T>(
  store: AchievementStore,
  method: keyof AchievementStore,
  build: (ours: SteamAchievement[]) => T,
) {
  // All three getters hand back the same envelope, so the loosest of them
  // stands in for whichever one is being patched.
  return afterPatch(store, method as "GetPlayerAchievements", (args, result) => {
    const [appId] = args;

    const ours = forAppId(appId);
    if (ours) return { data: build(ours) };

    return library.getByAppId(appId) ? { loading: true } : result;
  });
}

function patchStore(store: AchievementStore) {
  const patches = [
    patchGetter(store, "GetMyAchievements", (ours) => group(ours, true)),

    // Epic publishes the same "x% of players have this" Steam does, so the
    // rarity column on the page is real rather than blank.
    patchGetter(store, "GetGlobalAchievements", (ours) => {
      const rarities: GlobalAchievements = {};
      for (const achievement of ours) rarities[achievement.strID] = achievement.flAchieved;
      return rarities;
    }),

    // Asked for whoever's achievements are being looked at, which on our own
    // page is us. Nobody else can hold achievements for an Epic game, so ours
    // are the answer whichever account it asks about.
    patchGetter(store, "GetPlayerAchievements", (ours) => group(ours, false)),
  ];

  return () => {
    for (const patch of patches) patch.unpatch();
  };
}

export function register() {
  const component = findSectionsComponent();
  if (!component) {
    logger.warn("Could not find the app details sections component, achievements stay hidden");
    return () => {};
  }

  const patch = afterPatch(
    component.prototype,
    "GetSections",
    function (this: SectionsComponent["prototype"], args, sections: Set<string>) {
      const [overview] = args as [AppOverview, unknown];

      const game = library.getByAppId(overview.appid);
      if (!game || !listFor(game.appName)) return sections;

      sections.add("achievements");
      // The component hands back the Set it memoised whenever the one it just
      // built matches, so a Set edited after that comparison would be thrown
      // away on the very next render.
      this.m_setSectionsMemo = sections;
      return sections;
    },
  );

  // The page is a feature of its own: without the store the section still
  // draws, it just has nowhere to lead.
  const store = findAchievementStore();
  if (!store) logger.warn("Could not find the achievement store, the full page stays empty");
  const unpatchStore = store ? patchStore(store) : () => {};

  logger.debug("Registered the achievements patch");

  return () => {
    patch.unpatch();
    unpatchStore();
  };
}
