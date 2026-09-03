import rpc, { type AchievementSummary, type GameAchievements } from "../rpc";
import { getLastPlayed } from "../services/playtime";
import { createEmitter } from "./emitter";

// The same shape as state/sizes.ts, for the same reason: achievements are read
// one game at a time from a Steam render, which needs an answer now. Everything
// answers from memory, and asking about a game we don't have starts a fetch and
// tells its subscribers when it lands.
//
// Unlike a size, this does go stale - the point of an achievement is that the
// user unlocks it - so a cached answer past its age is served, then quietly
// refetched behind the render that asked for it.

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
 * Counts only, for every game the backend has cached - including ones nothing
 * has opened the details page for this session. Kept apart from `known` because
 * the library home asks about every game as it draws and must never start a
 * fetch, while `known` holds the full achievement lists a details page needs.
 */
const summaries = new Map<string, AchievementSummary>();

/**
 * Seed the counts from the backend's cache. One call for the whole library, no
 * round trip to Epic, so it's safe at startup.
 */
export async function loadSummaries() {
  const cached = await rpc.GetCachedAchievements();
  if (cached.size === 0) return;

  for (const [appName, summary] of cached) summaries.set(appName, summary);
  emitter.emit();

  // Held back: each game it re-reads is a legendary run, and those go through
  // the one Lua state every other RPC needs.
  setTimeout(() => void refreshPlayed(), STARTUP_GRACE_MS);
}

/**
 * Re-read every game that has been played since we last asked Epic about it.
 * One at a time: each is a legendary run, and a machine that has been away for
 * a while would otherwise start a dozen of them at once.
 */
async function refreshPlayed() {
  for (const [appName, summary] of summaries) {
    if (pending.has(appName) || !isStale(appName, summary)) continue;
    pending.add(appName);

    const result = await rpc.GetAchievements(appName, true);
    pending.delete(appName);
    if (result) record(appName, result);
  }
}

/**
 * Ask Epic again for one game, whatever we already hold - for a session just
 * ending, where the whole point is that what we hold is now short.
 */
export async function refresh(appName: string) {
  if (pending.has(appName)) return;
  pending.add(appName);

  const result = await rpc.GetAchievements(appName, true);
  pending.delete(appName);
  if (result) record(appName, result);
}

/**
 * How far through a game's achievements the account is, or undefined for a game
 * we've never read. Never fetches: this answers a render of the whole library.
 */
export function getSummary(appName: string): AchievementSummary | undefined {
  return summaries.get(appName);
}

/** Keep both maps on one answer, whichever read brought it back. */
function record(appName: string, result: GameAchievements) {
  known.set(appName, result);
  summaries.set(appName, {
    appName,
    total: result.total,
    unlocked: result.unlocked,
    fetchedAt: result.fetchedAt,
  });
  emitter.emit();
}

/** A game's achievements, if we already have them. Never blocks, never fetches. */
export function get(appName: string): GameAchievements | undefined {
  return known.get(appName) ?? undefined;
}

/** Enough of an answer to date it, which both a full read and a summary are. */
type Dated = { total: number; fetchedAt: number } | null | undefined;

function isStale(appName: string, entry: Dated): boolean {
  // A game with none at all is never worth asking about again - plenty of Epic
  // titles simply don't have any, and that can't change under us.
  if (!entry || entry.total === 0) return false;

  // Played since we asked, so whatever it unlocked is missing from what we
  // hold. This is Steam's own rule for its achievement cache, and it only sees
  // launches through Steam - the age check below is what catches a session
  // started from the Epic launcher instead.
  if (getLastPlayed(appName) > entry.fetchedAt) return true;

  return Date.now() - entry.fetchedAt * 1000 > STALE_AFTER_MS;
}

/**
 * Make sure we're getting this game's achievements, without waiting for them.
 * Called from a render path, so it has to be safe to call constantly.
 */
export function ensure(appName: string) {
  // The summary stands in for a game nothing has opened this session: it dates
  // the backend's cache just as well, and without it a game played since that
  // cache was written would be answered from it.
  const entry = known.get(appName) ?? summaries.get(appName);
  const stale = isStale(appName, entry);
  if ((known.has(appName) && !stale) || pending.has(appName)) return;
  pending.add(appName);

  void rpc.GetAchievements(appName, stale).then((result) => {
    pending.delete(appName);

    // Misses are recorded too: retrying every render is a subprocess a frame.
    // Except a refresh that came back empty - Epic being unreachable is no
    // reason to throw away the answer we already have.
    if (result) {
      record(appName, result);
    } else if (!stale) {
      known.set(appName, null);
    }
  });
}
