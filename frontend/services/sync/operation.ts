import { sleep } from "millennium";
import * as library from "../../state/library";
import { type SyncResult, progress } from "../../state/sync-progress";

// Shortcuts per batch before yielding, so a long run doesn't freeze the UI
const BATCH_SIZE = 10;

export function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

// A sync and a clean up share the active flag, so only one runs at a time
export function begin(operation: "sync" | "cleanUp", total: number) {
  if (progress.get().active) return false;
  progress.update({ active: true, operation, done: 0, total, lastResult: undefined });
  return true;
}

// The appid map changed either way, and every patch reads the library
export function finish(lastResult?: SyncResult) {
  library.reindexAppIds();
  progress.update({ active: false, done: 0, total: 0, lastResult });
}

export async function step(done: number, onBatch?: () => void) {
  progress.update({ done });
  if (done % BATCH_SIZE !== 0) return;

  onBatch?.();
  await sleep(0);
}
