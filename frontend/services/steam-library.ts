import * as appIds from "../state/app-ids";
import * as preferences from "../state/preferences";
import * as collection from "./collection";
import * as hidden from "./hidden";
import * as shortcuts from "./shortcuts";

// A sync followed by the preferences, so the collection and hiding cover games
// the sync just added. Everything that syncs goes through here.

/** Sync, then bring the collection and hiding in line with the toggles. */
export async function syncAll(games: EpicGame[]): Promise<shortcuts.SyncResult> {
  const result = await shortcuts.sync(games);
  if (!result.error) await applyPreferences(games);
  return result;
}

/** Apply the toggles to the shortcuts there are now, without syncing. */
export async function applyPreferences(games: EpicGame[]) {
  const { collection: collect, hideDuplicates } = preferences.get();

  if (hideDuplicates) hidden.setDuplicatesHidden(games, true);

  if (collect) {
    const error = await collection.addAll(games);
    if (error) console.warn("Couldn't fill the collection", error);
  }
}

/**
 * Sync after a library load when the user has opted in: auto sync is on and
 * they've added games before. Skipped when nothing differs, which saves a scan
 * of every shortcut on each startup.
 */
export async function autoSync(library: Library) {
  if (!preferences.get().autoSync || shortcuts.getSyncState().active) return;

  // An errored or empty load would read as every game leaving the account.
  const games = library.games;
  if (library.error || games.length === 0) return;

  // A shortcut removed outside the plugin still has its mapping, which would
  // count it as synced and skip it. Steam's list is empty until it loads.
  const steamShortcuts = appStore.allApps.map((app) => app.appid).filter(appIds.isShortcut);
  if (steamShortcuts.length > 0) appIds.prune(new Set(steamShortcuts));

  const synced = shortcuts.syncedCount(games);
  if (synced === 0) return;

  const owned = new Set(games.map((game) => game.app_name));
  const gone = Object.keys(appIds.getAll()).some((appName) => !owned.has(appName));
  if (synced === games.length && !gone) return;

  console.info("Library changed, syncing", { synced, total: games.length, gone });
  await syncAll(games);
}

/** Turning hiding off shows the duplicates again, and only them. */
export function setHideDuplicates(games: EpicGame[], value: boolean) {
  preferences.set("hideDuplicates", value);
  hidden.setDuplicatesHidden(games, value);
}

/**
 * Turning the collection off deletes it, unless the user added games of their own.
 * Returns why it couldn't be filled, if it couldn't.
 */
export async function setCollection(games: EpicGame[], value: boolean) {
  preferences.set("collection", value);
  if (value) return collection.addAll(games);
  await collection.removeIfEmpty(new Set(Object.values(appIds.getAll())));
  return undefined;
}
