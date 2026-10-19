import { createValue, poll } from "./primitives";

// Sign in and out happen on Epic's store in Steam's browser, out of the frontend's
// sight, so the backend's status is polled for them

const POLL_MS = 2000;

const status = createValue<EpicStatus | undefined>(undefined);

export const subscribe = status.subscribe;
export const get = status.get;

function same(a: EpicStatus | undefined, b: EpicStatus) {
  return (
    a?.available === b.available &&
    a.authenticated === b.authenticated &&
    a.account === b.account &&
    a.error === b.error
  );
}

// `onChange` hears the account changing, signing in or out included, not the first read
export function watch(onChange: (status: EpicStatus) => void) {
  let stopped = false;

  const check = async () => {
    let next: EpicStatus;
    try {
      next = await backend.GetStatus(false);
    } catch (reason: unknown) {
      console.warn("GetStatus failed", reason);
      return;
    }

    const previous = status.get();
    if (stopped || same(previous, next)) return;

    status.set(next);
    if (previous && previous.account !== next.account) onChange(next);
  };

  const stop = poll(() => void check(), POLL_MS);
  return () => {
    stopped = true;
    stop();
  };
}
