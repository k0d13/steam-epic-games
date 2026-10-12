import { callOriginal, replacePatch } from "millennium";
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

export function register() {
  const cache = Reflect.get(globalThis, "appAchievementProgressCache") as ProgressCache | undefined;
  if (!cache) {
    console.warn("Could not find the achievement progress cache, the completion sort stays empty");
    return () => {};
  }

  const patches = [
    // A game of ours with no achievements says so; Steam's own default for an
    // unknown appid is `true`, which would leave every uncached Epic game
    // sorting as 0% rather than as having none.
    replacePatch(cache, "BGameHasAchievements", ([appId]: [number]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as boolean;

      return (achievements.getSummary(game.app_name)?.total ?? 0) > 0;
    }),

    // Counts only, and never fetches: this runs once per game per render of the
    // whole library, and a command apiece would be a subprocess storm. The
    // details page is what fills the cache, plus the whole-library seed at
    // startup.
    replacePatch(cache, "GetAchievementProgress", ([appId]: [number]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as number;

      // A game of ours we have no counts for can't queue a CM update it would
      // only miss on, so it answers 0 rather than falling through.
      const summary = achievements.getSummary(game.app_name);
      return summary?.total ? Math.round((summary.unlocked / summary.total) * 100) : 0;
    }),
  ];

  console.debug("Registered the achievement progress patch");

  return () => {
    for (const patch of patches) patch.unpatch();
  };
}
