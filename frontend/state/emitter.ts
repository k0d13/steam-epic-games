/**
 * A set of listeners with no payload, which is all any of our stores needs:
 * everything reads the current value back off the module it subscribed to.
 *
 * The returned `subscribe` is stable, so it can go straight into
 * `useSyncExternalStore` without a wrapper.
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
