// Reaching into Steam's own webpack modules.
//
// @steambrew/client's findModuleExport only sees the module cache as it was
// when it loaded, and the library's chunks arrive later. Pushing our own chunk
// gets webpack's `require` itself, and from there everything is reachable.
//
// Factories are functions, so they can be searched by source without being run.
// Only modules whose source proves they're the right one are required, since
// requiring an unrelated one can have side effects.

interface WebpackRequire {
  (id: string): Record<string, unknown>;
  m: Record<string, unknown>;
}

let cached: WebpackRequire | undefined;

function getRequire(): WebpackRequire | undefined {
  if (cached) return cached;

  let webpackRequire: WebpackRequire | undefined;
  const id = Symbol("epic-games");
  const chunks = Reflect.get(globalThis, "webpackChunksteamui") as
    | { push(chunk: unknown[]): void }
    | undefined;
  chunks?.push([[id], {}, (r: WebpackRequire) => void (webpackRequire = r)]);

  cached = webpackRequire;
  return webpackRequire;
}

/**
 * The first export of a Steam module that matches, out of the modules whose
 * source contains `marker`.
 *
 * `marker` decides which modules are worth requiring and `matches` decides
 * what's wanted. Pick a marker Steam's build can't rename: a localisation
 * token, an error string, something it prints.
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
