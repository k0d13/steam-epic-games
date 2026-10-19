import { callOriginal, replacePatch } from "millennium";
import * as achievements from "../../state/achievements";
import * as library from "../../state/library";

// The "% of Achievements Completed" sort reads appAchievementProgressCache, filled from
// Steam's CM, which knows nothing of shortcuts, so we answer from our counts
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

      // A CM update would only miss for our games, so answer 0 rather than fall through
      const summary = achievements.getSummary(game.app_name);
      return summary?.total ? Math.round((summary.unlocked / summary.total) * 100) : 0;
    }),
  ];

  return () => patches.forEach((patch) => patch.unpatch());
}
