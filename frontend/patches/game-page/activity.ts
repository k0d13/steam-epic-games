import { callOriginal, replacePatch } from "millennium";
import * as achievements from "../../state/achievements";
import * as library from "../../state/library";
import { listFor } from "./achievements";

// Steam's details page drops the activity section for a shortcut, which game-info puts
// back through `ShortcutSections`. The feed is filled from Steam's servers, which know
// nothing of an Epic game, so backend/patches.lua has the store's fetch ask
// `EpicActivity` first and we add the unlocks to the feed ourselves, as Steam adds the
// ones its servers send

// Steam's EUserNewsType for an unlock
const ACHIEVEMENT_UNLOCKED = 2;

// A news event as the feed reads one, which Steam's servers send as a protobuf
interface NewsEvent {
  eventtype(): number;
  eventtime(): number;
  gameid(): string;
  steamid_actor(): string;
  achievement_names(): string[];
  toObject(): object;
}

interface AchievementEntry {
  strID: string;
  rtUnlocked: number;
}

// Steam's per-app feed, which groups events by day
interface Activity {
  m_AchievementMap: Map<number, Map<string, AchievementEntry>>;
  m_bNoMoreHistoryAvailable: boolean;
  appActivityByDay: { events: { appid: number }[] }[];
  AddUserNewsEvent(event: NewsEvent): Promise<void>;
  SortEvents(): void;
}

interface ActivityStore {
  m_mapAppActivity: Map<number, Activity>;
  m_CMInterface: { steamid: { ConvertTo64BitString(): string } };
}

// A feed is built once per session, so unlocks that arrive after it are added to the
// same one, and what's already in it is remembered
const feeds = new Map<number, { store: ActivityStore; activity: Activity }>();
const added = new WeakMap<Activity, Set<string>>();

async function fill(
  appId: number,
  { store, activity }: { store: ActivityStore; activity: Activity },
) {
  const game = library.getByAppId(appId);
  const list = game && listFor(game.app_name);
  if (!list) return;

  let entries = activity.m_AchievementMap.get(appId);
  if (!entries) {
    entries = new Map();
    activity.m_AchievementMap.set(appId, entries);
  }

  let done = added.get(activity);
  if (!done) {
    done = new Set();
    added.set(activity, done);
  }

  const actor = store.m_CMInterface.steamid.ConvertTo64BitString();
  const pending: Promise<void>[] = [];

  for (const achievement of list) {
    if (!achievement.bAchieved || achievement.rtUnlocked === 0 || done.has(achievement.strID)) {
      continue;
    }
    done.add(achievement.strID);
    entries.set(achievement.strID, achievement);

    pending.push(
      activity.AddUserNewsEvent({
        eventtype: () => ACHIEVEMENT_UNLOCKED,
        eventtime: () => achievement.rtUnlocked,
        gameid: () => String(appId),
        steamid_actor: () => actor,
        achievement_names: () => [achievement.strID],
        toObject: () => ({}),
      }),
    );
  }

  await Promise.all(pending);

  // A row is drawn only for a game with a visible store item, which Steam has none of for
  // ours, but one with no game at all is always drawn
  for (const day of activity.appActivityByDay) {
    for (const event of day.events) {
      if (event.appid === appId) Object.defineProperty(event, "appid", { value: 0 });
    }
  }

  activity.SortEvents();
}

// The feed's status box asks, as a post about an Epic game can't be made
export function IsEpicApp(appId: number) {
  return library.getByAppId(appId) !== undefined;
}

// True takes the place of the fetch from Steam, so the feed isn't left asking servers
// for a game they don't have
function takeOver(store: ActivityStore, activity: Activity, appId: number) {
  const game = library.getByAppId(appId);
  if (!game) return false;

  // There's no older history to ask Steam for
  activity.m_bNoMoreHistoryAvailable = true;

  const feed = { store, activity };
  feeds.set(appId, feed);
  achievements.ensure(game.app_name);
  void fill(appId, feed);
  return true;
}

export function register() {
  const global = globalThis.appActivityStore;
  if (!global) {
    console.warn("Could not find the activity store, an Epic game's feed stays empty");
    return () => {};
  }

  const store = global as typeof global & ActivityStore;

  // Steam's fetch asks its servers for news and activity, so for an Epic game it's ours
  const patch = replacePatch(
    store,
    "FetchLatestActivityFromServer",
    ([appId]: [number, boolean]) => {
      const activity = store.m_mapAppActivity.get(appId);
      if (activity && takeOver(store, activity, appId)) return Promise.resolve();
      return callOriginal as unknown as Promise<void>;
    },
  );
  const unsubscribe = achievements.subscribe(() => {
    for (const [appId, feed] of feeds) void fill(appId, feed);
  });

  return () => {
    patch.unpatch();
    unsubscribe();
  };
}
