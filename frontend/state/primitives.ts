import { useSyncExternalStore } from "react";

// Steam's render path reads state synchronously and outside React, so state lives
// in modules and these shapes cover all of it: a signal to say something changed,
// a value to hold one thing, a cache to hold one thing per key, and a store to
// keep things per key across restarts.

export interface Signal {
  /** Stable, so it goes straight into `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
}

/**
 * Listeners, with no payload by default so they read whatever changed off the
 * module. Give one when the event itself is the news, like a job ending.
 */
export function createSignal<T = void>() {
  const listeners = new Set<(value: T) => void>();

  return {
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    emit(value: T) {
      for (const listener of listeners) listener(value);
    },
  };
}

export interface Readable<T> extends Signal {
  get(): T;
}

/**
 * One value that tells its subscribers when it's replaced. Setting the same value
 * again is ignored, so callers can set unconditionally.
 */
export function createValue<T>(initial: T) {
  const signal = createSignal();
  let current = initial;

  return {
    subscribe: signal.subscribe,
    get: () => current,

    set(next: T) {
      if (Object.is(next, current)) return;
      current = next;
      signal.emit();
    },

    /** Merge into an object value, as a new object so snapshots stay comparable. */
    update(changes: Partial<T>) {
      current = { ...current, ...changes };
      signal.emit();
    },
  };
}

/** Render with a value, re-rendering when it changes. A module with `get` and `subscribe` works too. */
export function useValue<T>(source: Readable<T>): T {
  return useSyncExternalStore(source.subscribe, source.get);
}

interface CacheOptions<V> {
  /** `refresh` asks the backend to look past its own cache too. Nothing back is a miss. */
  fetch(key: string, refresh: boolean): Promise<V | null | undefined>;
  /** Whether an answer, or the lack of one, is old enough to ask again. Never, by default. */
  isStale?(key: string, value: V | undefined): boolean;
  /**
   * localStorage key to keep answers under, versioned like `createStore`'s. After a
   * restart they're served at once, and asked for again behind the render.
   */
  persist?: string;
}

/**
 * Answers per key from memory, for render paths that can't wait: `get` never
 * fetches, `ensure` starts a fetch if needed and is safe to call every render.
 * Misses are remembered, or every render would run a subprocess. An answer that
 * goes out of date is still served until its replacement arrives.
 */
export function createCache<V>({ fetch, isStale = () => false, persist }: CacheOptions<V>) {
  const signal = createSignal();
  const saved = persist ? createStore<V>(persist) : undefined;

  /** `null` records a key we asked about and got nothing for, so we stop asking. */
  const values = new Map<string, V | null>();
  const pending = new Set<string>();

  /** Keys served from `saved` that the backend hasn't been asked about since the restart. */
  const restored = new Set<string>();

  /** Keys whose next read has to go past the backend's cache. See `invalidate`. */
  const invalidated = new Set<string>();

  /** Bring a key's saved answer into memory, the first time it's wanted. */
  function restore(key: string) {
    if (values.has(key)) return;

    const value = saved?.get(key);
    if (value === undefined) return;
    values.set(key, value);
    restored.add(key);
  }

  async function load(key: string, refresh: boolean) {
    if (pending.has(key)) return;
    pending.add(key);

    let result: V | null | undefined;
    try {
      result = await fetch(key, refresh);
    } finally {
      pending.delete(key);
      invalidated.delete(key);
      restored.delete(key);
    }

    if (result) {
      // Asking again mostly brings back what we served, which needs no repaint.
      const changed = JSON.stringify(result) !== JSON.stringify(values.get(key));
      values.set(key, result);
      if (!changed) return;

      saved?.set(key, result);
      signal.emit();
    } else if (!values.get(key)) {
      // A failed refresh keeps the answer we already have.
      values.set(key, null);
    }
  }

  function needsRefresh(key: string) {
    return invalidated.has(key) || isStale(key, values.get(key) ?? undefined);
  }

  return {
    subscribe: signal.subscribe,

    /** Tell subscribers about something the caller keeps beside the cache. */
    notify: signal.emit,

    /** The answer for a key, if we already have it. Never blocks, never fetches. */
    get(key: string): V | undefined {
      restore(key);
      return values.get(key) ?? undefined;
    },

    /** Make sure we're getting this key's answer, without waiting for it. */
    ensure(key: string) {
      if (pending.has(key)) return;
      restore(key);

      const held = values.get(key);
      const settled = values.has(key) && !invalidated.has(key) && !restored.has(key);
      if (settled && (held === null || !isStale(key, held))) return;

      void load(key, needsRefresh(key)).catch((reason: unknown) => {
        console.warn("Cache fetch failed", { key, reason });
      });
    },

    /** Ask again for one key, whatever we already hold. */
    refresh: (key: string) => load(key, true),

    /**
     * Mark a key's answer out of date. It's served until the next read has asked
     * again, past the backend's cache too.
     */
    invalidate(key: string) {
      invalidated.add(key);
    },
  };
}

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
