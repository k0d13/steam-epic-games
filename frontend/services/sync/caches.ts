import * as achievements from "../../state/achievements";
import * as info from "../../state/info";
import * as preferences from "../../state/preferences";
import * as sizes from "../../state/sizes";
import { begin, errorMessage, finish, step } from "./operation";

// The library's filters and collections only know the games whose info has been read, and
// that happens as a page is opened; this reads the rest. The backend answers one call at a
// time, so it goes game by game
export async function loadAll(games: EpicGame[]) {
  if (!begin("load", games.length)) return;

  try {
    let done = 0;
    for (const { app_name } of games) {
      try {
        if (preferences.get().gameInfo) await info.fill(app_name);
        await achievements.fill(app_name);
      } catch (reason: unknown) {
        // One game failing shouldn't stop the rest
        console.warn("Could not load a game's info", { app_name, reason });
      }
      await step(++done);
    }
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
