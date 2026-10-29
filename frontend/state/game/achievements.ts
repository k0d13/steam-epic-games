import { getLastPlayed } from "../../services/steam/playtime";
import { createCache } from "../primitives";

// Not saved, as full lists outgrow the localStorage every plugin shares and the backend
// keeps them on disk

const STALE_AFTER_MS = 10 * 60 * 1000;

// Each re-read is a legendary run, so the catch-up waits for the client to start up
const STARTUP_GRACE_MS = 30_000;

type Counts = Pick<AchievementSummary, "total" | "unlocked" | "fetched_at">;

// Counts for every game the backend has cached; kept apart because the library home
// reads every game as it draws and must never start a fetch
const summaries = new Map<string, AchievementSummary>();

// Games with none never get any
function playedSince(appName: string, entry: Counts) {
  return entry.total > 0 && getLastPlayed(appName) > entry.fetched_at;
}

// Steam's own rule only sees Steam launches, the age check catches the Epic launcher's
function isStale(appName: string, entry: Counts) {
  if (entry.total === 0) return false;
  return playedSince(appName, entry) || Date.now() - entry.fetched_at * 1000 > STALE_AFTER_MS;
}

const cache = createCache<GameAchievements>({
  fetch: (appName, refresh) => backend.GetAchievements(appName, refresh),
  isStale,
  async clearRemote() {
    await backend.ClearCache("achievements");
    summaries.clear();
  },
});

export const subscribe = cache.subscribe;
export const get = cache.get;
export const ensure = cache.ensure;
export const refresh = cache.refresh;
export const forget = cache.invalidate;
export const fill = cache.fill;
export const clear = cache.clear;

export function getSummary(appName: string) {
  return cache.get(appName) ?? summaries.get(appName);
}

export async function loadSummaries() {
  // Lua sends {} for an empty list
  const cached = Object.values(await backend.GetCachedAchievements());
  if (cached.length === 0) return;

  for (const summary of cached) summaries.set(summary.app_name, summary);
  cache.notify();

  setTimeout(() => void refreshPlayed(), STARTUP_GRACE_MS);
}

// Only games played since they were read, as age alone would re-read every game each start
async function refreshPlayed() {
  for (const [appName, summary] of summaries) {
    // One at a time: the backend runs legendary in-process, so a batch would hold up every other call
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    if (playedSince(appName, summary)) await refresh(appName);
  }
}
