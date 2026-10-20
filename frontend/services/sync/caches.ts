import * as achievements from "../../state/achievements";
import * as info from "../../state/info";
import * as preferences from "../../state/preferences";
import * as sizes from "../../state/sizes";
import { begin, errorMessage, finish, step } from "./operation";

export interface LoadResult {
  loaded: number;
  failed: number;
}

// The library's filters and collections only know the games whose details have been read,
// which happens as a page is opened; this reads the rest. The backend answers one call at
// a time, so it goes game by game
export async function loadAll(games: EpicGame[]): Promise<LoadResult | undefined> {
  if (!begin("load", games.length)) return undefined;

  const result = { loaded: 0, failed: 0 };
  try {
    let done = 0;
    for (const { app_name } of games) {
      // One game failing shouldn't stop the rest
      try {
        const withInfo = preferences.get().gameInfo;
        if (withInfo) await info.fill(app_name);
        await achievements.fill(app_name);

        // A fill that got nothing back leaves nothing to read
        const read = achievements.get(app_name) && (!withInfo || info.get(app_name));
        if (read) result.loaded++;
        else result.failed++;
      } catch (reason: unknown) {
        console.warn("Could not load a game's details", { app_name, reason });
        result.failed++;
      }
      await step(++done);
    }
    return result;
  } finally {
    finish();
  }
}

// Returns an error to show, or undefined
export async function clearAll() {
  try {
    await Promise.all([info.clear(), achievements.clear(), sizes.clear()]);
    return undefined;
  } catch (reason: unknown) {
    console.error("Clearing the caches failed", reason);
    return errorMessage(reason);
  }
}
