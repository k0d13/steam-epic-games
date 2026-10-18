import { useSyncExternalStore } from "react";

// Steam's render path reads state synchronously and outside React, so state lives
// in modules and these three shapes cover all of it: a signal to say something
// changed, a value to hold one thing, and a cache to hold one thing per key.

export interface Signal {
  /** Stable, so it goes straight into `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
}

/** Listeners with no payload; they read whatever changed off the module. */
export function createSignal() {
  const listeners = new Set<() => void>();

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    emit() {
      for (const listener of listeners) listener();
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
  /** Hears every answer that arrives, before subscribers do. */
  onLoad?(key: string, value: V): void;
}

/**
 * Answers per key from memory, for render paths that can't wait: `get` never
 * fetches, `ensure` starts a fetch if needed and is safe to call every render.
 * Misses are remembered, or every render would run a subprocess.
 */
export function createCache<V>({ fetch, isStale = () => false, onLoad }: CacheOptions<V>) {
  const signal = createSignal();

  /** `null` records a key we asked about and got nothing for, so we stop asking. */
  const values = new Map<string, V | null>();
  const pending = new Set<string>();

  /** Keys whose next read has to go past the backend's cache. See `invalidate`. */
  const invalidated = new Set<string>();

  async function load(key: string, refresh: boolean) {
    if (pending.has(key)) return;
    pending.add(key);

    let result: V | null | undefined;
    try {
      result = await fetch(key, refresh);
    } finally {
      pending.delete(key);
      invalidated.delete(key);
    }

    if (result) {
      values.set(key, result);
      onLoad?.(key, result);
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
      return values.get(key) ?? undefined;
    },

    /** Make sure we're getting this key's answer, without waiting for it. */
    ensure(key: string) {
      if (pending.has(key)) return;

      const held = values.get(key);
      const settled = values.has(key) && !invalidated.has(key);
      if (settled && (held === null || !isStale(key, held))) return;

      void load(key, needsRefresh(key)).catch((reason: unknown) => {
        console.warn("Cache fetch failed", { key, reason });
      });
    },

    /** Ask again for one key, whatever we already hold. */
    refresh: (key: string) => load(key, true),

    /** Drop a key's answer, and have the next read go past the backend's cache too. */
    invalidate(key: string) {
      values.delete(key);
      invalidated.add(key);
    },
  };
}
