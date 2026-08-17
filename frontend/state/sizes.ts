import rpc, { type GameSize } from "../rpc";

// Sizes are read one game at a time, off the back of a Steam render that needs
// a synchronous answer and can't wait several seconds for Epic. So everything
// here answers from memory immediately, and asking for a game we don't have
// starts the fetch and tells its subscribers when it lands.

/** `null` records a game we asked about and got nothing for, so we stop asking. */
const known = new Map<string, GameSize | null>();
const pending = new Set<string>();

const listeners = new Set<() => void>();

/** The size of a game, if we already have it. Never blocks and never fetches. */
export function get(appName: string): GameSize | undefined {
  return known.get(appName) ?? undefined;
}

/**
 * Make sure we're getting this game's size, without waiting for it. Does
 * nothing if it's already known, already being fetched, or already failed -
 * this is called from a render path, so it has to be safe to call constantly.
 */
export function ensure(appName: string) {
  if (known.has(appName) || pending.has(appName)) return;
  pending.add(appName);

  void rpc.GetGameSize(appName).then((size) => {
    pending.delete(appName);

    // A miss is usually Epic being unreachable. Recorded either way: retrying
    // on every render would mean a subprocess per frame.
    known.set(appName, size ?? null);
    if (size) for (const listener of listeners) listener();
  });
}

/** Called when a size arrives, so whatever is showing it can repaint. */
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop what we know about a game, so the next look asks again. For after an
 * install or an update, when the build we measured is no longer the current one.
 */
export function forget(appName: string) {
  known.delete(appName);
}
