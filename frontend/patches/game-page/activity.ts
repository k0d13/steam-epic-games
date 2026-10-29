import { callOriginal, replacePatch } from "millennium";
import * as achievements from "../../state/game/achievements";
import * as friendAchievements from "../../state/game/friend-achievements";
import * as library from "../../state/library";
import { listFor } from "./achievements";
import { standIn } from "./friends";

// The feed is filled from Steam's servers, which know nothing of an Epic game, so the
// store's fetch is taken over and the unlocks added to the feed ourselves, friends' too,
// whom ./friends makes Steam's friend store answer for

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

  const done = added.get(activity) ?? new Set<string>();
  added.set(activity, done);

  const pending: Promise<void>[] = [];

  function add(actor: string, strID: string, unlockedAt: number) {
    const key = `${actor}:${strID}`;
    if (done.has(key)) return;
    done.add(key);

    pending.push(
      activity.AddUserNewsEvent({
        eventtype: () => ACHIEVEMENT_UNLOCKED,
        eventtime: () => unlockedAt,
        gameid: () => String(appId),
        steamid_actor: () => actor,
        achievement_names: () => [strID],
        toObject: () => ({}),
      }),
    );
  }

  const self = store.m_CMInterface.steamid.ConvertTo64BitString();
  for (const achievement of list) {
    if (!achievement.bAchieved || achievement.rtUnlocked === 0) continue;
    entries.set(achievement.strID, achievement);
    add(self, achievement.strID, achievement.rtUnlocked);
  }

  // A row looks its achievement up in the map, and a friend may hold ones we don't
  const friends = friendAchievements.get(game.app_name)?.friends;
  if (friends) {
    for (const achievement of list) entries.set(achievement.strID, achievement);

    // Lua sends {} for an empty list
    for (const friend of Object.values(friends)) {
      const actor = standIn(friend);
      for (const unlock of Object.values(friend.unlocks)) {
        if (entries.has(unlock.id)) add(actor, unlock.id, unlock.unlocked_at);
      }
    }
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
  friendAchievements.ensure(game.app_name);
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
  const refill = () => {
    for (const [appId, feed] of feeds) void fill(appId, feed);
  };
  const unsubscribes = [achievements.subscribe(refill), friendAchievements.subscribe(refill)];

  return () => {
    patch.unpatch();
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}
