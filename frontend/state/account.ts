import { createValue } from "./signal";

// Sign in and out happen on Epic's store in Steam's browser (see epic-session), out
// of the frontend's sight, so the backend's status is polled for them.

const POLL_MS = 2000;

const status = createValue<EpicStatus | undefined>(undefined);

export const subscribe = status.subscribe;
export const get = status.get;

const sameStatus = (a: EpicStatus | undefined, b: EpicStatus) =>
  a?.available === b.available &&
  a.authenticated === b.authenticated &&
  a.account === b.account &&
  a.error === b.error;

/**
 * Polls until the returned function is called. `onChange` hears the account
 * changing, signing in or out included, and not the first read.
 */
export function watch(onChange: (status: EpicStatus) => void): () => void {
  let stopped = false;

  const check = async () => {
    let next: EpicStatus;
    try {
      next = await backend.GetStatus(false);
    } catch (reason: unknown) {
      console.warn("GetStatus failed", reason);
      return;
    }
    if (stopped) return;

    const previous = status.get();
    if (sameStatus(previous, next)) return;

    status.set(next);
    if (previous && previous.account !== next.account) onChange(next);
  };

  void check();
  const timer = setInterval(check, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
