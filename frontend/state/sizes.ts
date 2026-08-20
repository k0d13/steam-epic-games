import rpc, { type GameSize } from "../rpc";
import { createEmitter } from "./emitter";

// Sizes are read one game at a time from a Steam render, which needs an answer
// now. So everything here answers from memory, and asking for a game we don't
// have starts a fetch and tells its subscribers when it lands.

/** `null` records a game we asked about and got nothing for, so we stop asking. */
const known = new Map<string, GameSize | null>();
const pending = new Set<string>();

/** Fires when a size arrives, so whatever is showing it can repaint. */
const emitter = createEmitter();
export const subscribe = emitter.subscribe;

/** The size of a game, if we already have it. Never blocks and never fetches. */
export function get(appName: string): GameSize | undefined {
  return known.get(appName) ?? undefined;
}

/**
 * Make sure we're getting this game's size, without waiting for it. Called from
 * a render path, so it has to be safe to call constantly.
 */
export function ensure(appName: string) {
  if (known.has(appName) || pending.has(appName)) return;
  pending.add(appName);

  void rpc.GetGameSize(appName).then((size) => {
    pending.delete(appName);

    // Misses are recorded too: retrying every render is a subprocess a frame.
    known.set(appName, size ?? null);
    if (size) emitter.emit();
  });
}

/**
 * Drop what we know about a game, for after an install or update has changed
 * the build it was measured against.
 */
export function forget(appName: string) {
  known.delete(appName);
}
