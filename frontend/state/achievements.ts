import rpc, { type GameAchievements } from "../rpc";
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

/** `null` records a game we asked about and got nothing for, so we stop asking. */
const known = new Map<string, GameAchievements | null>();
const pending = new Set<string>();

/** Fires when achievements arrive, so whatever is showing them can repaint. */
const emitter = createEmitter();
export const subscribe = emitter.subscribe;

/** A game's achievements, if we already have them. Never blocks, never fetches. */
export function get(appName: string): GameAchievements | undefined {
  return known.get(appName) ?? undefined;
}

function isStale(entry: GameAchievements | null | undefined): boolean {
  // A game with none at all is never worth asking about again - plenty of Epic
  // titles simply don't have any, and that can't change under us.
  if (!entry || entry.total === 0) return false;
  return Date.now() - entry.fetchedAt * 1000 > STALE_AFTER_MS;
}

/**
 * Make sure we're getting this game's achievements, without waiting for them.
 * Called from a render path, so it has to be safe to call constantly.
 */
export function ensure(appName: string) {
  const stale = isStale(known.get(appName));
  if ((known.has(appName) && !stale) || pending.has(appName)) return;
  pending.add(appName);

  void rpc.GetAchievements(appName, stale).then((result) => {
    pending.delete(appName);

    // Misses are recorded too: retrying every render is a subprocess a frame.
    // Except a refresh that came back empty - Epic being unreachable is no
    // reason to throw away the answer we already have.
    if (result) {
      known.set(appName, result);
      emitter.emit();
    } else if (!stale) {
      known.set(appName, null);
    }
  });
}
