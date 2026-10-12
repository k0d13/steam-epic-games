/**
 * Cache the first answer, `undefined` included: a Steam internal missing from a
 * build won't appear later.
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

/** Run once, so a patch on a render path logs its first pass and not every frame. */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let done = false;

  return (...args: A) => {
    if (done) return;
    done = true;
    fn(...args);
  };
}
