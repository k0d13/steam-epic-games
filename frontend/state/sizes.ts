import { createEmitter } from "./emitter";

// Answers from memory for Steam's render path; an unknown game starts a fetch and
// notifies subscribers when it lands.

/** `null` records a game we asked about and got nothing for, so we stop asking. */
const known = new Map<string, GameSize | null>();
const pending = new Set<string>();

/** Games whose next read has to go past the backend's cache too. See `forget`. */
const stale = new Set<string>();

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

  void backend.GetGameSize(appName, stale.has(appName)).then((size) => {
    pending.delete(appName);
    stale.delete(appName);

    // Misses are recorded too: retrying every render is a subprocess a frame.
    known.set(appName, size ?? null);
    if (size) emitter.emit();
  });
}

/**
 * Drop a game's size here and in the backend, whose cache can't tell a new build
 * shipped. state/jobs.ts calls this when a job finishes.
 */
export function forget(appName: string) {
  known.delete(appName);
  stale.add(appName);
}
