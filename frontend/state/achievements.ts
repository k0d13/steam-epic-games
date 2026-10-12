import { getLastPlayed } from "../services/playtime";
import { createEmitter } from "./emitter";

// Like state/sizes.ts, answers from memory for Steam's render path. Stale answers
// are served, then refetched behind the render that asked.

/** How old an answer can get before the next read goes back to Epic. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** How long the catch-up read waits for the client to finish starting up. */
const STARTUP_GRACE_MS = 30_000;

/** `null` records a game we asked about and got nothing for, so we stop asking. */
const known = new Map<string, GameAchievements | null>();
const pending = new Set<string>();

/** Fires when achievements arrive, so whatever is showing them can repaint. */
const emitter = createEmitter();
export const subscribe = emitter.subscribe;

/**
 * Counts for every game the backend has cached. Kept apart from `known` because the
 * library home reads every game as it draws and must never start a fetch.
 */
const summaries = new Map<string, AchievementSummary>();

/** Seed the counts from the backend's cache, without asking Epic. */
export async function loadSummaries() {
  // An empty list arrives as `{}` (Lua has one table type); Object.values reads both.
  const cached = Object.values(await backend.get_cached_achievements());
  if (cached.length === 0) return;

  for (const summary of cached) summaries.set(summary.app_name, summary);
  emitter.emit();

  // Held back: each re-read is a legendary run, blocking every other backend call.
  setTimeout(() => void refreshPlayed(), STARTUP_GRACE_MS);
}

/** Re-read games played since we last asked Epic, one legendary run at a time. */
async function refreshPlayed() {
  for (const [appName, summary] of summaries) {
    if (isStale(appName, summary)) await refresh(appName);
  }
}

/** Ask Epic again for one game, whatever we already hold. */
export async function refresh(appName: string) {
  if (pending.has(appName)) return;
  pending.add(appName);

  const result = await backend.get_achievements(appName, true);
  pending.delete(appName);
  if (result) record(appName, result);
}

/** A game's achievement counts, if read. Never fetches: the whole library asks. */
export function getSummary(appName: string): AchievementSummary | undefined {
  return summaries.get(appName);
}

/** Keep both maps on one answer, whichever read brought it back. */
function record(appName: string, result: GameAchievements) {
  known.set(appName, result);
  summaries.set(appName, {
    app_name: appName,
    total: result.total,
    unlocked: result.unlocked,
    fetched_at: result.fetched_at,
  });
  emitter.emit();
}

/** A game's achievements, if we already have them. Never blocks, never fetches. */
export function get(appName: string): GameAchievements | undefined {
  return known.get(appName) ?? undefined;
}

/** Enough of an answer to date it, which both a full read and a summary are. */
type Dated = { total: number; fetched_at: number } | null | undefined;

function isStale(appName: string, entry: Dated): boolean {
  // Games with none never get any.
  if (!entry || entry.total === 0) return false;

  // Steam's own rule. It only sees Steam launches; the age check catches sessions
  // started from the Epic launcher.
  if (getLastPlayed(appName) > entry.fetched_at) return true;

  return Date.now() - entry.fetched_at * 1000 > STALE_AFTER_MS;
}

/** Start fetching this game's achievements if needed. Safe to call every render. */
export function ensure(appName: string) {
  // The summary dates the backend's cache for games nothing has opened this session.
  const entry = known.get(appName) ?? summaries.get(appName);
  const stale = isStale(appName, entry);
  if ((known.has(appName) && !stale) || pending.has(appName)) return;
  pending.add(appName);

  void backend.get_achievements(appName, stale).then((result) => {
    pending.delete(appName);

    // Misses are recorded, or every render runs a subprocess. A failed refresh
    // keeps the answer we already have.
    if (result) {
      record(appName, result);
    } else if (!stale) {
      known.set(appName, null);
    }
  });
}
