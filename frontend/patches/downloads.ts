import { logger } from "../index";
import { type Job } from "../rpc";
import * as appIds from "../state/app-ids";
import * as jobs from "../state/jobs";
import * as sizes from "../state/sizes";

// The downloads page draws its sections - Active, Queued, Not queued, Completed
// - out of four getters on the downloads store, and all four start from one:
// `AllTransfers`, the list the native side publishes for the client being
// viewed. Our installs are added to what that getter answers, as items in the
// shape the native side sends, so the page files them where it would a Steam
// download of its own.
//
// The page doesn't watch the list. It snapshots the sections whenever the
// store dispatches its items-changed callback, so every change here dispatches
// too.
//
// The buttons need nothing extra: Pause and Resume on the active row are
// EnableAllDownloads, Download on a queued one is ResumeAppUpdate, and the ✕ is
// RemoveFromDownloadList - all already routed to legendary by installs.ts. The
// ✕ on a finished row goes through `dismiss` instead of cancelling anything.

/** How long a finished install stays under Completed. */
const COMPLETED_FOR_MS = 60 * 60 * 1000;

/** EAppUpdateContentType: Content, Workshop, Shader. */
const CONTENT_TYPES = 3;
const CONTENT = 0;

/** EAppUpdateProgress has seven stages; the page reads the download one. */
const PROGRESS_STAGES = 7;
export const PROGRESS_DOWNLOAD = 2;

/** The steamclient's own "no error", one of the three the page accepts. */
const NO_ERROR = 0;

interface UpdateProgress {
  bytes_in_progress: number;
  bytes_total: number;
  estimated_time_remaining_sec: number;
}

interface UpdateTypeInfo {
  has_update: boolean;
  completed: boolean;
  progress: UpdateProgress[];
}

/** One row of the page. Every field is read by the page or its sort. */
interface DownloadItem {
  appid: number;
  active: boolean;
  paused: boolean;
  completed: boolean;
  /** Unix seconds; the Completed section orders by it and hides a 0. */
  completed_time: number;
  /** Place in the queue, -1 for an item that isn't in it. */
  queue_index: number;
  deferred_time: number;
  /** Both 0, so the patch notes link has nothing to look up. */
  buildid: number;
  target_buildid: number;
  update_result: number;
  update_error: string;
  launch_on_completion: boolean;
  is_invalid_os_type: boolean;
  update_type_info: UpdateTypeInfo[];
}

interface DownloadsStore {
  readonly AllTransfers: DownloadItem[];
  readonly BIsViewingLocalClient: boolean;
  m_fnCallbackDownloadItemsChanged?: { Dispatch(changed: boolean): void };
}

function getStore(): DownloadsStore | undefined {
  return Reflect.get(globalThis, "downloadsStore") as DownloadsStore | undefined;
}

/** Installs that finished this session, as app name -> when, in ms. */
const completed = new Map<string, number>();

/** What was downloading on the last pass, to tell a finish from a cancel. */
let downloading = new Set<string>();

const isDownload = (job: Job) => job.kind === "install" || job.kind === "update";

function stages(bytesInProgress: number, bytesTotal: number, eta: number): UpdateProgress[] {
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

/** "01:02:03" to seconds, -1 for anything legendary didn't say. */
export function etaSeconds(eta: string | undefined) {
  if (!eta) return -1;

  const parts = eta.split(":").map(Number);
  if (parts.some(Number.isNaN)) return -1;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Bytes for a job's progress. legendary counts chunks, not bytes, so the
 * figure is the percentage of Epic's download size - and only for a fresh
 * install, since an update's size isn't something we can ask for.
 */
export function bytesFor(job: Job) {
  const total = job.kind === "install" ? (sizes.get(job.appName)?.download ?? 0) : 0;
  if (job.kind === "install") sizes.ensure(job.appName);

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
    completed_time: 0,
    queue_index: -1,
    deferred_time: 0,
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

/** Our rows, queued after whatever Steam has queued itself. */
function ours(theirs: DownloadItem[]): DownloadItem[] {
  const items: DownloadItem[] = [];
  let next = Math.max(-1, ...theirs.map((transfer) => transfer.queue_index)) + 1;

  for (const job of [...jobs.active(), ...jobs.queued()].filter(isDownload)) {
    const appId = appIds.getAppId(job.appName);
    if (appId === undefined) continue;

    const [done, total] = bytesFor(job);
    items.push(
      item(
        appId,
        { active: job.state === "running", queue_index: next++ },
        stages(done, total, etaSeconds(job.progress?.eta)),
      ),
    );
  }

  // Paused is "removed from the queue" to Steam, which is also where its own
  // paused downloads go, with a button to put them back.
  for (const job of jobs.paused().filter(isDownload)) {
    const appId = appIds.getAppId(job.appName);
    if (appId === undefined) continue;

    const [done, total] = bytesFor(job);
    items.push(item(appId, { paused: true }, stages(done, total, -1)));
  }

  for (const [appName, at] of completed) {
    const appId = appIds.getAppId(appName);
    if (appId === undefined) continue;

    items.push(
      item(appId, { completed: true, completed_time: Math.floor(at / 1000) }, stages(0, 0, -1)),
    );
  }

  return items;
}

/** Move installs that just finished under Completed, and drop the stale ones. */
function track() {
  const now = Date.now();

  for (const appName of downloading) {
    if (jobs.get(appName)?.state === "done") completed.set(appName, now);
  }

  for (const [appName, at] of completed) {
    // A new download of the same game takes the row back to Active.
    if (now - at > COMPLETED_FOR_MS || jobs.get(appName)?.state === "running") {
      completed.delete(appName);
    }
  }

  downloading = new Set(
    [...jobs.active(), ...jobs.queued(), ...jobs.paused()]
      .filter(isDownload)
      .map((job) => job.appName),
  );
}

/** Have the page take a fresh snapshot of its sections. */
function dispatch() {
  getStore()?.m_fnCallbackDownloadItemsChanged?.Dispatch(true);
}

/** Bring the page up to date with the jobs. Called on every repaint. */
export function sync() {
  track();
  dispatch();
}

/**
 * Take a finished row off the page, for its ✕ and Completed's "clear all".
 * Says whether it was one of ours, so the caller knows not to cancel anything.
 */
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
  const store = getStore();
  const getter =
    store && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), "AllTransfers")?.get;
  if (!store || !getter) {
    logger.warn("Steam's downloads store wasn't found, Epic downloads stay off its page");
    return () => {};
  }

  // An own property in front of the prototype's getter, so taking it away again
  // is a delete. The store is a plain class instance, not a proxy, so this is
  // all mobx would have seen of it anyway.
  Object.defineProperty(store, "AllTransfers", {
    configurable: true,
    get(this: DownloadsStore) {
      const theirs = getter.call(this) as DownloadItem[];
      // Our downloads run here, not on a remote client being viewed.
      return this.BIsViewingLocalClient ? [...theirs, ...ours(theirs)] : theirs;
    },
  });

  dispatch();

  logger.debug("Registered the downloads patch");
  return () => {
    Reflect.deleteProperty(store, "AllTransfers");
    dispatch();
  };
}
