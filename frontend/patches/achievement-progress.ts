import { callOriginal, replacePatch } from "millennium";
import * as achievements from "../state/achievements";
import * as library from "../state/library";

// The "% of Achievements Completed" sort reads appAchievementProgressCache, filled
// from Steam's CM, which knows nothing of shortcuts, so we answer from our counts.

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
    // Steam defaults unknown appids to `true`, so uncached games would sort as 0%.
    replacePatch(cache, "BGameHasAchievements", ([appId]: [number]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as boolean;

      return (achievements.getSummary(game.app_name)?.total ?? 0) > 0;
    }),

    // Never fetches: this runs per game on every library render. Counts come from
    // details pages and the startup seed.
    replacePatch(cache, "GetAchievementProgress", ([appId]: [number]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal as unknown as number;

      // A CM update would only miss for our games, so answer 0 rather than fall through.
      const summary = achievements.getSummary(game.app_name);
      return summary?.total ? Math.round((summary.unlocked / summary.total) * 100) : 0;
    }),
  ];

  console.debug("Registered the achievement progress patch");

  return () => {
    for (const patch of patches) patch.unpatch();
  };
}
