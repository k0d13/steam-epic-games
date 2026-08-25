import { callOriginal, replacePatch } from "@steambrew/client";
import { logger } from "../index";
import * as achievements from "../state/achievements";
import * as library from "../state/library";

// The library home's "% of Achievements Completed" sort reads none of the
// stores achievements.ts patches. It goes through appAchievementProgressCache,
// a global of its own that keeps one number per appid:
//
//   BGameHasAchievements(appid)  -> is the game worth sorting at all
//   GetAchievementProgress(appid) -> 0 to 100, or a queued cache update on a miss
//
// The cache is filled from Steam's CM, which knows nothing about a shortcut, so
// every Epic game misses, reads as 0, and sorts as "no achievements" however
// much of it we have cached. Answering both out of our own counts is the fix.

interface ProgressCache {
  BGameHasAchievements(appId: number): boolean;
  GetAchievementProgress(appId: number): number;
}

function getCache(): ProgressCache | undefined {
  return Reflect.get(globalThis, "appAchievementProgressCache") as ProgressCache | undefined;
}

/**
 * One game's completion, 0 to 100, or undefined for anything that isn't ours or
 * that we've never read. Counts only, and never fetches: this runs once per game
 * per render of the whole library, and a command apiece would be a subprocess
 * storm. The details page is what fills the cache, plus the whole-library seed
 * at startup.
 */
function progressFor(appId: number): number | undefined {
  const game = library.getByAppId(appId);
  if (!game) return undefined;

  const summary = achievements.getSummary(game.appName);
  if (!summary || summary.total === 0) return undefined;

  return Math.round((summary.unlocked / summary.total) * 100);
}

export function register() {
  const cache = getCache();
  if (!cache) {
    logger.warn("Could not find the achievement progress cache, the completion sort stays empty");
    return () => {};
  }

  const patches = [
    // A game of ours with no achievements says so; Steam's own default for an
    // unknown appid is `true`, which would leave every uncached Epic game
    // sorting as 0% rather than as having none.
    replacePatch(cache, "BGameHasAchievements", (args: [number]) => {
      const [appId] = args;
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as boolean;

      const summary = achievements.getSummary(game.appName);
      return summary ? summary.total > 0 : false;
    }),

    replacePatch(cache, "GetAchievementProgress", (args: [number]) => {
      const progress = progressFor(args[0]);
      // Anything not ours falls through, and so does a game of ours we have no
      // counts for - except that one can't queue a CM update it would only miss
      // on, so it answers 0 rather than nothing.
      if (progress !== undefined) return progress;
      return library.getByAppId(args[0]) ? 0 : (callOriginal as unknown as number);
    }),
  ];

  logger.debug("Registered the achievement progress patch");

  return () => {
    for (const patch of patches) patch.unpatch();
  };
}
