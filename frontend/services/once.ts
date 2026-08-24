// Two shapes that kept getting written out by hand: finding a Steam internal
// exactly once, and logging exactly once that a patch took effect.

/**
 * Remember what `resolve` answered the first time, `undefined` included. For
 * the Steam internals we find by source string - the search walks every webpack
 * module, and a build that doesn't have it won't grow one later.
 */
export function memo<T>(resolve: () => T): () => T {
  let value: T;
  let resolved = false;

  return () => {
    if (!resolved) {
      resolved = true;
      value = resolve();
    }
    return value;
  };
}

/**
 * Wrap a function so it only ever runs once. The patches log what they actually
 * wrote back on their first pass - enough to tell a field that's read-only on
 * this build from one that took - and a patch on a render path would otherwise
 * say it every frame.
 */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let done = false;

  return (...args: A) => {
    if (done) return;
    done = true;
    fn(...args);
  };
}
