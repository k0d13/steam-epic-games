// Reaching into Steam's own webpack modules.
//
// @steambrew/client's findModuleExport searches the module cache it built when
// it loaded, and the library's chunks load later than that - so anything in
// them simply isn't in it. Pushing our own chunk gets webpack's `require`
// instead, and from there every module is reachable.
//
// Module *factories* are functions, so they can be searched by source without
// being run: only modules whose source proves they're the right one are
// required, and requiring an unrelated module can have side effects.

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
 * `marker` is only a filter over factory source - it decides which modules are
 * worth requiring, and `matches` decides what's actually wanted. Pick something
 * for it that Steam's own build can't rename: a localisation token, an error
 * string, a method name it prints somewhere.
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
