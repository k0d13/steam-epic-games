import * as achievements from "../../state/game/achievements";
import * as info from "../../state/game/info";
import * as sizes from "../../state/game/sizes";
import * as preferences from "../../state/preferences";
import { begin, errorMessage, finish, step } from "./operation";

export interface LoadResult {
  loaded: number;
  failed: number;
  // Already had their details, so weren't asked about
  skipped: number;
}

function isRead(appName: string, withInfo: boolean) {
  // A summary is what the library reads, and the backend's cache already has those
  return achievements.getSummary(appName) !== undefined && (!withInfo || info.get(appName));
}

// Reads the details of games not yet opened, so the library's filters and collections
// know them; one at a time, as the backend answers one call at a time
export async function loadAll(games: EpicGame[]) {
  const withInfo = preferences.get().gameInfo;
  const missing = games.filter((game) => !isRead(game.app_name, withInfo));
  if (!begin("load", missing.length)) return undefined;

  const result = { loaded: 0, failed: 0, skipped: games.length - missing.length };
  try {
    let done = 0;
    for (const { app_name } of missing) {
      // One game failing shouldn't stop the rest
      try {
        if (withInfo) await info.fill(app_name);
        await achievements.fill(app_name);

        // A fill that got nothing back leaves nothing to read
        if (isRead(app_name, withInfo)) result.loaded++;
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
