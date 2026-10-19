import { sleep } from "millennium";
import * as appIds from "../../state/app-ids";
import * as library from "../../state/library";
import { progress } from "../../state/sync-progress";
import * as artwork from "../steam/artwork";
import * as collection from "../steam/collection";
import * as shortcuts from "../steam/shortcuts";
import { begin, errorMessage, finish, step } from "./operation";

// The backend answers one call at a time, so either of these can keep the bar up indefinitely
const TIDY_TIMEOUT_MS = 15_000;

export interface CleanUpResult {
  removed: number;
  error?: string;
}

// Removes every shortcut this plugin ever made, whether or not it still knows about
// them, with their artwork and the collection; installs and the sign-in are left alone
export async function cleanUp() {
  if (!begin("cleanUp", 0)) return { removed: 0, error: "A sync is still running." };

  try {
    const ids = new Set(Object.values(appIds.getAll()));
    for (const { appId } of await shortcuts.findOurs()) ids.add(appId);

    // The map can hold appids Steam no longer has, and removing those is a no-op
    const present = new Set(appStore.allApps.map((app) => app.appid));
    const removed = [...ids].filter((appId) => present.has(appId)).length;

    progress.update({ total: ids.size });

    let done = 0;
    for (const appId of ids) {
      shortcuts.remove(appId);
      await step(++done);
    }

    // Before anything that waits, so the shortcuts being gone is never forgotten
    appIds.clear();
    artwork.forgetAll();
    library.reindexAppIds();

    const timeout = sleep(TIDY_TIMEOUT_MS);
    const [artworkRemoved] = await Promise.all([
      Promise.race([shortcuts.removeArtwork([...ids]), timeout]),
      Promise.race([collection.removeIfEmpty(ids), timeout]),
    ]);

    console.info("Cleaned up the Steam library", { removed, artworkRemoved });
    return { removed };
  } catch (reason: unknown) {
    console.error("Clean up failed", reason);
    return { removed: 0, error: errorMessage(reason) };
  } finally {
    finish();
  }
}
