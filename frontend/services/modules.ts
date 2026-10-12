// findModuleExport only sees modules loaded before it, and the library's chunks
// come later, so we push a chunk to get webpack's `require` itself.

import { memo } from "./once";

interface WebpackRequire {
  (id: string): Record<string, unknown>;
  m: Record<string, unknown>;
}

const getRequire = memo((): WebpackRequire | undefined => {
  let webpackRequire: WebpackRequire | undefined;
  const id = Symbol("epic-games");
  const chunks = Reflect.get(globalThis, "webpackChunksteamui") as
    | { push(chunk: unknown[]): void }
    | undefined;
  chunks?.push([[id], {}, (r: WebpackRequire) => void (webpackRequire = r)]);

  return webpackRequire;
});

/**
 * The first matching export among modules whose source has `marker`; others are
 * never required. Pick a marker builds can't rename, like a localisation token.
 */
export function findExport<T>(
  marker: string,
  matches: (value: unknown) => value is T,
): T | undefined {
  const webpackRequire = getRequire();
  if (!webpackRequire) return undefined;

  for (const moduleId of Object.keys(webpackRequire.m)) {
    const factory = webpackRequire.m[moduleId];
    if (typeof factory !== "function" || !factory.toString().includes(marker)) continue;

    for (const value of Object.values(webpackRequire(moduleId))) {
      if (matches(value)) return value;
    }
  }

  return undefined;
}
