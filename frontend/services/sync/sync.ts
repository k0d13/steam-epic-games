import * as appIds from "../../state/app-ids";
import * as library from "../../state/library";
import * as preferences from "../../state/preferences";
import { progress, type SyncResult } from "../../state/sync-progress";
import * as artwork from "../steam/artwork";
import * as collection from "../steam/collection";
import * as hidden from "../steam/hidden";
import * as shortcuts from "../steam/shortcuts";
import { begin, errorMessage, finish, step } from "./operation";

// Brings Steam's library in line with Epic's: a shortcut per game, then the
// collection and hiding the toggles ask for

export function syncedCount(games: EpicGame[]) {
  const known = appIds.getAll();
  return games.filter((game) => known[game.app_name] !== undefined).length;
}

function ownedNames(games: EpicGame[]) {
  return new Set(games.map((game) => game.app_name));
}

// Adopts shortcuts the appid map lost and removes every extra for a game that has one
async function adoptExisting() {
  const keep = new Map<string, number>();
  const extras: number[] = [];

  for (const { appId, appName } of await shortcuts.findOurs()) {
    const kept = keep.get(appName);
    if (kept === undefined) {
      keep.set(appName, appId);
    } else if (appId === appIds.getAppId(appName)) {
      // The mapped one wins, since it's the one with our artwork applied
      extras.push(kept);
      keep.set(appName, appId);
    } else {
      extras.push(appId);
    }
  }

  for (const [appName, appId] of keep) {
    if (appIds.getAppId(appName) === appId) continue;
    appIds.setAppId(appName, appId);
    // Its artwork may be another install's, or none at all
    artwork.forget(appName);
  }

  for (const appId of extras) shortcuts.remove(appId);
  await shortcuts.removeArtwork(extras);

  if (extras.length > 0) console.info("Removed duplicate shortcuts", { count: extras.length });
  return extras.length;
}

// Touches only what differs, then applies the toggles so they cover games just added
export async function sync(games: EpicGame[]) {
  const result: SyncResult = { added: 0, removed: 0, failed: 0 };
  if (!begin("sync", games.length)) return result;

  try {
    // Before anything is created, or a lost map adds every game a second time
    result.removed += await adoptExisting();

    // Shortcuts the user deleted by hand would otherwise look synced forever
    appIds.prune(new Set(shortcuts.steamShortcuts()));

    // A game that left the account would launch into an ownership error
    const owned = ownedNames(games);
    for (const [appName, appId] of Object.entries(appIds.getAll())) {
      if (owned.has(appName)) continue;
      shortcuts.remove(appId);
      appIds.removeAppName(appName);
      artwork.forget(appName);
      result.removed++;
    }

    let done = 0;
    let unindexed = false;

    for (const game of games) {
      const existing = appIds.getAppId(game.app_name);
      const appId = existing ?? (await shortcuts.create(game));

      if (appId === undefined) {
        result.failed++;
      } else if (existing === undefined) {
        result.added++;
        unindexed = true;
      }

      // Also covers shortcuts made by a sync that was interrupted partway
      if (appId !== undefined && !artwork.isDone(game.app_name)) await artwork.apply(appId, game);

      // Unmapped shortcuts read as installed, so each batch reindexes to keep that short
      await step(++done, () => {
        if (unindexed) library.reindexAppIds();
        unindexed = false;
      });
    }

    const prefs = preferences.get();
    if (prefs.hideDuplicates) hidden.setDuplicatesHidden(games, true);
    const error = prefs.collection ? await collection.addAll(games) : undefined;
    if (error) console.warn("Couldn't fill the collection", error);

    console.info("Shortcut sync complete", result);
  } catch (reason: unknown) {
    // Returned, not thrown, as the panel may not be open to catch it
    console.error("Shortcut sync failed", reason);
    result.error = errorMessage(reason);
  } finally {
    finish(result);
  }

  return result;
}

// Skipped when nothing differs, which saves a scan of every shortcut on each startup
export async function autoSync(epic: Library) {
  if (!preferences.get().autoSync || progress.get().active) return;

  // An errored or empty load would read as every game leaving the account
  const { games } = epic;
  if (epic.error || games.length === 0) return;

  // A shortcut removed outside the plugin still has its mapping, which would count it
  // as synced; Steam's list is empty until it loads
  const inSteam = shortcuts.steamShortcuts();
  if (inSteam.length > 0) appIds.prune(new Set(inSteam));

  // Only for people who have added games before
  const synced = syncedCount(games);
  if (synced === 0) return;

  const owned = ownedNames(games);
  const gone = Object.keys(appIds.getAll()).some((appName) => !owned.has(appName));
  if (synced === games.length && !gone) return;

  console.info("Library changed, syncing", { synced, total: games.length, gone });
  await sync(games);
}

// Turning hiding off shows the duplicates again, and only them
export function setHideDuplicates(games: EpicGame[], value: boolean) {
  preferences.set("hideDuplicates", value);
  hidden.setDuplicatesHidden(games, value);
}

// Turning it off deletes the collection unless the user added games of their own;
// returns why it couldn't be filled, if it couldn't
export async function setCollection(games: EpicGame[], value: boolean) {
  preferences.set("collection", value);
  if (value) return collection.addAll(games);

  await collection.removeIfEmpty(new Set(Object.values(appIds.getAll())));
  return undefined;
}
