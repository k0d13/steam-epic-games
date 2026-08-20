import { logger } from "../index";

/**
 * A record kept in localStorage and mirrored in memory: a sync reads once per
 * game and writes back for most of them, and re-parsing the document each time
 * is UI-thread work for an answer we already have.
 *
 * `key` should be versioned, so a change to what's stored throws the old
 * entries away rather than half-reading them.
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
      logger.debug(`Failed to read ${key}`, e);
      cache = {};
    }

    return cache;
  }

  function writeAll(entries: Record<string, T>) {
    cache = entries;

    try {
      localStorage.setItem(key, JSON.stringify(entries));
    } catch (e) {
      logger.debug(`Failed to write ${key}`, e);
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
