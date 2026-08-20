/**
 * A set of listeners with no payload: everything reads the current value back
 * off the module it subscribed to. `subscribe` is stable, so it goes straight
 * into `useSyncExternalStore`.
 */
export function createEmitter() {
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
