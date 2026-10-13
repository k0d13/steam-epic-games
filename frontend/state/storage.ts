/**
 * A localStorage record mirrored in memory, so syncs don't re-parse it per game.
 * Version `key` so a format change drops old entries rather than half-reading them.
 */
export function createStore<T>(key: string) {
  let cache: Record<string, T> | undefined;

  function readAll(): Record<string, T> {
    if (cache) return cache;

    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      cache = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, T>) : {};
    } catch (e) {
      console.debug(`Failed to read ${key}`, e);
      cache = {};
    }

    return cache;
  }

  function writeAll(entries: Record<string, T>) {
    cache = entries;

    try {
      localStorage.setItem(key, JSON.stringify(entries));
    } catch (e) {
      console.debug(`Failed to write ${key}`, e);
    }
  }

  return {
    /** Every entry, as a copy - callers iterate this while removing entries. */
    getAll(): Record<string, T> {
      return { ...readAll() };
    },

    get(name: string): T | undefined {
      return readAll()[name];
    },

    set(name: string, value: T) {
      const entries = readAll();
      entries[name] = value;
      writeAll(entries);
    },

    remove(name: string) {
      const entries = readAll();
      delete entries[name];
      writeAll(entries);
    },

    clear() {
      writeAll({});
    },

    /** Drop every entry the predicate rejects. */
    keep(predicate: (name: string, value: T) => boolean) {
      const entries = readAll();
      let changed = false;

      for (const [name, value] of Object.entries(entries)) {
        if (predicate(name, value)) continue;
        delete entries[name];
        changed = true;
      }

      if (changed) writeAll(entries);
    },
  };
}
