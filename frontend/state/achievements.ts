import { getLastPlayed } from "../services/playtime";
import { createCache } from "./signal";

// Like state/sizes.ts, answers from memory for Steam's render path. Stale answers
// are served, then refetched behind the render that asked.

/** How old an answer can get before the next read goes back to Epic. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** How long the catch-up read waits for the client to finish starting up. */
const STARTUP_GRACE_MS = 30_000;

/**
 * Counts for every game the backend has cached. Kept apart from the full answers
 * because the library home reads every game as it draws and must never start a fetch.
 */
const summaries = new Map<string, AchievementSummary>();

/** Enough of an answer to date it, which both a full read and a summary are. */
type Dated = { total: number; fetched_at: number };

function isStale(appName: string, entry: Dated | undefined): boolean {
  // The summary dates the backend's cache for games nothing has opened this session.
  entry ??= summaries.get(appName);

  // Games with none never get any.
  if (!entry || entry.total === 0) return false;

  // Steam's own rule. It only sees Steam launches; the age check catches sessions
  // started from the Epic launcher.
  if (getLastPlayed(appName) > entry.fetched_at) return true;

  return Date.now() - entry.fetched_at * 1000 > STALE_AFTER_MS;
}

const cache = createCache<GameAchievements>({
  fetch: (appName, refresh) => backend.GetAchievements(appName, refresh),
  isStale,
  // Keep the summary on the same answer, whichever read brought it back.
  onLoad(appName, result) {
    summaries.set(appName, {
      app_name: appName,
      total: result.total,
      unlocked: result.unlocked,
      fetched_at: result.fetched_at,
    });
  },
});

/** Fires when achievements or counts arrive, so whatever is showing them can repaint. */
export const subscribe = cache.subscribe;

/** A game's achievements, if we already have them. Never blocks, never fetches. */
export const get = cache.get;

/** Start fetching this game's achievements if needed. Safe to call every render. */
export const ensure = cache.ensure;

/** Ask Epic again for one game, whatever we already hold. */
export const refresh = cache.refresh;

/** Drop a game's achievements, so the next read asks Epic again. */
export function forget(appName: string) {
  cache.invalidate(appName);
  summaries.delete(appName);
}

/** A game's achievement counts, if read. Never fetches: the whole library asks. */
export function getSummary(appName: string): AchievementSummary | undefined {
  return summaries.get(appName);
}

/** Seed the counts from the backend's cache, without asking Epic. */
export async function loadSummaries() {
  // An empty list arrives as `{}` (Lua has one table type); Object.values reads both.
  const cached = Object.values(await backend.GetCachedAchievements());
  if (cached.length === 0) return;

  for (const summary of cached) summaries.set(summary.app_name, summary);
  cache.notify();

  // Held back: each re-read is a legendary run, blocking every other backend call.
  setTimeout(() => void refreshPlayed(), STARTUP_GRACE_MS);
}

/** Re-read games played since we last asked Epic, one legendary run at a time. */
async function refreshPlayed() {
  for (const [appName, summary] of summaries) {
    if (isStale(appName, summary)) await refresh(appName);
  }
}
