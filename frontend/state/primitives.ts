import { useSyncExternalStore } from "react";

// Steam's render path reads state synchronously and outside React, so it lives in modules
// built from these: a signal, a value, a cache per key, a store kept across restarts

interface Signal {
  subscribe(listener: () => void): () => void;
}

export interface Readable<T> extends Signal {
  get(): T;
}

// Payload-less by default, so listeners read whatever changed off the module
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

// Setting the same value again is ignored, so callers can set unconditionally
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

    // A new object each time, so snapshots stay comparable
    update(changes: Partial<T>) {
      current = { ...current, ...changes };
      signal.emit();
    },
  };
}

export function useValue<T>(source: Readable<T>) {
  return useSyncExternalStore(source.subscribe, source.get);
}

// Calls `run` now and every `ms` after, until the returned function is called
export function poll(run: () => void, ms: number) {
  run();
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
}

interface CacheOptions<V> {
  // `refresh` asks the backend to look past its own cache too, nothing back is a miss
  fetch(key: string, refresh: boolean): Promise<V | null | undefined>;
  isStale?(key: string, value: V | undefined): boolean;
  // localStorage key, versioned like createStore's; saved answers are served at once after a restart
  persist?: string;
  // Empties the backend's copy, before `clear` forgets ours
  clearRemote?(): Promise<unknown>;
}

/**
 * Answers per key from memory, for render paths that can't wait: `get` never fetches,
 * `ensure` starts a fetch if needed and is safe to call every render. Misses are
 * remembered, and a stale answer is served until its replacement arrives.
 */
export function createCache<V>({
  fetch,
  isStale = () => false,
  persist,
  clearRemote,
}: CacheOptions<V>) {
  const signal = createSignal();
  const saved = persist ? createStore<V>(persist) : undefined;

  // null records a key we asked about and got nothing for
  const values = new Map<string, V | null>();
  const pending = new Set<string>();
  // Served from `saved` but not yet asked about since the restart
  const restored = new Set<string>();
  // Next read has to go past the backend's cache
  const invalidated = new Set<string>();

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
    } catch (reason) {
      // Remembered as a miss, or every render asks again
      if (!values.get(key)) values.set(key, null);
      throw reason;
    } finally {
      pending.delete(key);
      invalidated.delete(key);
      restored.delete(key);
    }

    if (result) {
      // Asking again mostly brings back what we served, which needs no repaint
      const changed = JSON.stringify(result) !== JSON.stringify(values.get(key));
      values.set(key, result);
      if (!changed) return;

      saved?.set(key, result);
      signal.emit();
    } else if (!values.get(key)) {
      // A failed refresh keeps the answer we already have
      values.set(key, null);
    }
  }

  return {
    subscribe: signal.subscribe,
    notify: signal.emit,

    get(key: string) {
      restore(key);
      return values.get(key) ?? undefined;
    },

    ensure(key: string) {
      if (pending.has(key)) return;
      restore(key);

      const held = values.get(key);
      const settled = values.has(key) && !invalidated.has(key) && !restored.has(key);
      if (settled && (held === null || !isStale(key, held))) return;

      const refresh = invalidated.has(key) || isStale(key, held ?? undefined);
      void load(key, refresh).catch((reason: unknown) => {
        console.warn("Cache fetch failed", { key, reason });
      });
    },

    refresh: (key: string) => load(key, true),

    // Resolves once the key has an answer, for work that wants one rather than a fresh one:
    // a saved answer will do, and an earlier miss is asked about again
    fill(key: string) {
      restore(key);
      if (values.get(key) && !invalidated.has(key)) return Promise.resolve();
      return load(key, invalidated.has(key));
    },

    // Forgets every answer, here and saved, so the next read asks again
    async clear() {
      await clearRemote?.();
      values.clear();
      restored.clear();
      invalidated.clear();
      saved?.clear();
      signal.emit();
    },

    // Served until the next read has asked again, past the backend's cache too
    invalidate(key: string) {
      invalidated.add(key);
    },
  };
}

// A localStorage record mirrored in memory; version `key` so a format change drops old entries
export function createStore<T>(key: string) {
  let cache: Record<string, T> | undefined;

  function readAll() {
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
      console.warn(`Failed to write ${key}`, e);
    }
  }

  return {
    // A copy, since callers iterate it while removing entries
    getAll: () => ({ ...readAll() }),
    get: (name: string) => readAll()[name],

    set(name: string, value: T) {
      writeAll({ ...readAll(), [name]: value });
    },

    remove(name: string) {
      const { [name]: _, ...rest } = readAll();
      writeAll(rest);
    },

    clear() {
      writeAll({});
    },

    keep(predicate: (name: string, value: T) => boolean) {
      const entries = Object.entries(readAll());
      const kept = entries.filter(([name, value]) => predicate(name, value));
      if (kept.length !== entries.length) writeAll(Object.fromEntries(kept));
    },
  };
}
