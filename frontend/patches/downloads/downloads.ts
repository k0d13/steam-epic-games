import * as appIds from "../../state/app-ids";
import * as jobs from "../../state/jobs";
import * as sizes from "../../state/sizes";

// Every section of the downloads page derives from the store's `AllTransfers`, so our
// jobs are appended there in the native shape; the page only re-reads on dispatch

const COMPLETED_FOR_MS = 60 * 60 * 1000;

// EAppUpdateContentType: Content, Workshop, Shader
const CONTENT_TYPES = 3;
const CONTENT = 0;

// EAppUpdateProgress has seven stages and the page reads the download one
const PROGRESS_STAGES = 7;
export const PROGRESS_DOWNLOAD = 2;

// The steamclient's own "no error", one of the three the page accepts
const NO_ERROR = 0;

// Installs that finished this session, as app name -> when, in ms
const completed = new Map<string, number>();

// What was downloading on the last pass, to tell a finish from a cancel
let downloading = new Set<string>();

function stages(bytesInProgress: number, bytesTotal: number, eta: number) {
  return Array.from({ length: PROGRESS_STAGES }, (_, stage) =>
    stage === PROGRESS_DOWNLOAD
      ? {
          bytes_in_progress: bytesInProgress,
          bytes_total: bytesTotal,
          estimated_time_remaining_sec: eta,
        }
      : { bytes_in_progress: 0, bytes_total: 0, estimated_time_remaining_sec: -1 },
  );
}

// "01:02:03" to seconds, -1 for anything legendary didn't say
export function etaSeconds(eta: string | null | undefined) {
  if (!eta) return -1;

  const parts = eta.split(":").map(Number);
  if (parts.some(Number.isNaN)) return -1;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

// legendary counts chunks, so bytes are its percentage of Epic's download size, which
// we only know for fresh installs
export function bytesFor(job: Job) {
  if (job.kind !== "install") return [0, 0] as const;

  sizes.ensure(job.app_name);
  const total = sizes.get(job.app_name)?.download ?? 0;
  return [Math.round((total * (job.progress?.percent ?? 0)) / 100), total] as const;
}

function item(
  appId: number,
  fields: Partial<DownloadItem>,
  progress: UpdateProgress[],
): DownloadItem {
  return {
    appid: appId,
    active: false,
    paused: false,
    completed: false,
    // Unix seconds, which the Completed section orders by and hides at 0
    completed_time: 0,
    queue_index: -1,
    deferred_time: 0,
    // Both 0, so the patch notes link has nothing to look up
    buildid: 0,
    target_buildid: 0,
    update_result: NO_ERROR,
    update_error: "",
    launch_on_completion: false,
    is_invalid_os_type: false,
    update_type_info: Array.from({ length: CONTENT_TYPES }, (_, type) => ({
      has_update: type === CONTENT,
      completed: type === CONTENT && fields.completed === true,
      progress: type === CONTENT ? progress : stages(0, 0, -1),
    })),
    ...fields,
  };
}

// Our rows, queued after whatever Steam has queued itself
function ours(theirs: DownloadItem[]) {
  const items: DownloadItem[] = [];
  let next = Math.max(-1, ...theirs.map((transfer) => transfer.queue_index)) + 1;

  for (const job of [...jobs.running(), ...jobs.queued()].filter(jobs.isDownload)) {
    const appId = appIds.getAppId(job.app_name);
    if (appId === undefined) continue;

    const [done, total] = bytesFor(job);
    const fields = { active: job.state === "running", queue_index: next++ };
    items.push(item(appId, fields, stages(done, total, etaSeconds(job.progress?.eta))));
  }

  // Steam files paused downloads as unqueued, with a button to resume
  for (const job of jobs.paused().filter(jobs.isDownload)) {
    const appId = appIds.getAppId(job.app_name);
    if (appId === undefined) continue;

    const [done, total] = bytesFor(job);
    items.push(item(appId, { paused: true }, stages(done, total, -1)));
  }

  for (const [appName, at] of completed) {
    const appId = appIds.getAppId(appName);
    if (appId === undefined) continue;

    const fields = { completed: true, completed_time: Math.floor(at / 1000) };
    items.push(item(appId, fields, stages(0, 0, -1)));
  }

  return items;
}

// Moves installs that just finished under Completed, and drops the stale ones
function track() {
  const now = Date.now();

  for (const appName of downloading) {
    if (jobs.get(appName)?.state === "done") completed.set(appName, now);
  }

  for (const [appName, at] of completed) {
    // A new download of the same game takes the row back to Active
    if (now - at > COMPLETED_FOR_MS || jobs.get(appName)?.state === "running") {
      completed.delete(appName);
    }
  }

  downloading = new Set(
    [...jobs.running(), ...jobs.queued(), ...jobs.paused()]
      .filter(jobs.isDownload)
      .map((job) => job.app_name),
  );
}

// Has the page take a fresh snapshot of its sections
function dispatch() {
  globalThis.downloadsStore?.m_fnCallbackDownloadItemsChanged?.Dispatch(true);
}

// Called on every repaint
export function sync() {
  track();
  dispatch();
}

// For a finished row's ✕ and Completed's "clear all"; says whether it was one of
// ours, so the caller knows not to cancel anything
export function dismiss(appId: number) {
  for (const appName of completed.keys()) {
    if (appIds.getAppId(appName) !== appId) continue;

    completed.delete(appName);
    dispatch();
    return true;
  }

  return false;
}

export function register() {
  const store = globalThis.downloadsStore;
  const getter =
    store && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), "AllTransfers")?.get;
  if (!store || !getter) {
    console.warn("Steam's downloads store wasn't found, Epic downloads stay off its page");
    return () => {};
  }

  // An own property shadowing the prototype getter, so unpatching is a delete
  Object.defineProperty(store, "AllTransfers", {
    configurable: true,
    get(this: NonNullable<typeof store>) {
      const theirs = getter.call(this) as DownloadItem[];
      // Our downloads run here, not on a remote client being viewed
      return this.BIsViewingLocalClient ? [...theirs, ...ours(theirs)] : theirs;
    },
  });

  dispatch();

  return () => {
    Reflect.deleteProperty(store, "AllTransfers");
    dispatch();
  };
}
