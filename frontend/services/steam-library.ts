import * as appIds from "../state/app-ids";
import * as library from "../state/library";
import * as preferences from "../state/preferences";
import * as collection from "./collection";
import { onPossibleOrder } from "./epic-session";
import * as hidden from "./hidden";
import { notify } from "./notifications";
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

/** Epic takes a moment to list an order, and an order is several requests; waited after the last. */
const AFTER_CHECKOUT_MS = 5_000;

/** A second look for an order Epic hadn't listed by the first. */
const RETRY_AFTER_MS = 60_000;

/**
 * Refresh the library, and so auto sync, after an order in Steam's browser.
 * A false alarm costs one refresh.
 */
export function watchOrders(): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  /** The games owned when the current order was spotted, to tell what it added. */
  let before: Set<string> | undefined;

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  /** Refresh and sync, then say what arrived. Returns whether anything did. */
  const look = async (last: boolean): Promise<boolean> => {
    const result = await library.load(true, true);
    if (result.error) {
      notify("message", "Couldn't check your Epic library", result.error);
      return true;
    }

    await autoSync(result);

    const added = result.games.filter((game) => !before?.has(game.app_name));
    if (added.length > 0) {
      announce(added);
      return true;
    }

    if (last)
      notify("message", "No new Epic games", "Nothing new showed up in your library after that.");
    return false;
  };

  const unsubscribe = onPossibleOrder(() => {
    // A burst of signals is one order: announced once, refreshed after the last.
    if (timers.size === 0) {
      before = new Set(library.getLatest()?.games.map((game) => game.app_name));
      notify(
        "message",
        "Checking your Epic library",
        "Looks like you got a game on the Epic store.",
      );
    }
    for (const timer of timers) clearTimeout(timer);
    timers.clear();

    later(AFTER_CHECKOUT_MS, () => {
      void look(false)
        .then((found) => {
          if (!found) later(RETRY_AFTER_MS, () => void look(true).catch(() => {}));
        })
        .catch((reason: unknown) => console.warn("Refresh after an order failed", reason));
    });
  });

  return () => {
    unsubscribe();
    for (const timer of timers) clearTimeout(timer);
  };
}

/** Name what an order added, and whether it's in Steam yet. */
function announce(games: EpicGame[]) {
  const names = games.slice(0, 2).map((game) => game.title);
  if (games.length > 2) names.push(`${games.length - 2} more`);
  const list = names.join(names.length > 2 ? ", " : " and ");

  const inSteam = games.every((game) => appIds.getAppId(game.app_name) !== undefined);
  const title = games.length === 1 ? "New Epic game" : `${games.length} new Epic games`;
  const body = inSteam
    ? `${list} ${games.length === 1 ? "is" : "are"} in your Steam library.`
    : `Found ${list}. Add ${games.length === 1 ? "it" : "them"} to Steam from the plugin's page.`;

  notify("message", title, body);
}
