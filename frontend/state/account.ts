import { createEmitter } from "./emitter";

// Sign in and out happen on Epic's store in Steam's browser (see epic-session), out
// of the frontend's sight, so the backend's status is polled for them.

const POLL_MS = 2000;

let status: EpicStatus | undefined;

const emitter = createEmitter();
export const subscribe = emitter.subscribe;

export function get(): EpicStatus | undefined {
  return status;
}

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

    const previous = status;
    if (
      previous?.available === next.available &&
      previous.authenticated === next.authenticated &&
      previous.account === next.account &&
      previous.error === next.error
    ) {
      return;
    }

    status = next;
    emitter.emit();
    if (previous && previous.account !== next.account) onChange(next);
  };

  void check();
  const timer = setInterval(check, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
