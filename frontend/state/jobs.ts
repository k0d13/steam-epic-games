import * as library from "./library";
import { createSignal } from "./signal";
import * as sizes from "./sizes";

// The backend can't push, so this polls, but only while a job is running or queued.

const POLL_MS = 1000;

const byAppName = new Map<string, Job>();

const signal = createSignal();
export const subscribe = signal.subscribe;

const endListeners = new Set<(job: Job) => void>();

/** Hear a job that ran to the end, done or failed; not a pause or a cancel. */
export function onEnded(listener: (job: Job) => void) {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** The current job for one game, running or finished, if it has ever had one. */
export function get(appName: string): Job | undefined {
  return byAppName.get(appName);
}

const inState = (state: string) => [...byAppName.values()].filter((job) => job.state === state);

/** The one job legendary is running, as a list since the backend can't promise one. */
export const running = () => inState("running");

/** Waiting on the one legendary run the backend allows, oldest request first. */
export const queued = () => inState("queued").sort((a, b) => a.started_at - b.started_at);

export const paused = () => inState("paused");

/** Downloads, which the downloads page shows, rather than uninstalls, which it doesn't. */
export const isDownload = (job: Job) => job.kind === "install" || job.kind === "update";

/** What the UI can tell apart: Steam draws the bar in whole percent. */
const shownPercent = (job: Job | undefined) =>
  job?.progress ? Math.round(job.progress.percent) : undefined;

/**
 * Fold in one poll. `finished` changes whether a game is installed; `changed` is
 * false when a repaint would draw nothing new.
 */
function apply(jobs: Job[]) {
  const finished: string[] = [];
  const ended: Job[] = [];
  let changed = false;

  for (const job of jobs) {
    const previous = byAppName.get(job.app_name);
    if (previous?.state === "running" && job.state !== "running") finished.push(job.app_name);
    if (previous?.state === "running" && (job.state === "done" || job.state === "failed")) {
      ended.push(job);
    }

    if (!previous || previous.state !== job.state || shownPercent(previous) !== shownPercent(job)) {
      changed = true;
    }

    byAppName.set(job.app_name, job);
  }

  // A vanished job was cancelled, leaving its download on disk, so it counts as finished.
  const seen = new Set(jobs.map((job) => job.app_name));
  for (const appName of byAppName.keys()) {
    if (seen.has(appName)) continue;
    byAppName.delete(appName);
    finished.push(appName);
    changed = true;
  }

  return { finished, ended, changed };
}

function announce(ended: Job[]) {
  for (const job of ended) for (const listener of endListeners) listener(job);
}

// An empty list arrives as `{}` (Lua has one table type); Object.values reads both.

async function poll() {
  timer = undefined;

  let jobs: Job[];
  try {
    jobs = Object.values(await backend.GetJobs());
  } catch (reason: unknown) {
    // One failed call shouldn't leave a dead poller behind mid-download.
    console.warn("GetJobs failed", reason);
    schedule();
    return;
  }

  const { finished, ended, changed } = apply(jobs);

  if (finished.length > 0) {
    // The cached "Space Required" predates whatever this job just did.
    for (const appName of finished) sizes.forget(appName);

    // Before the emit, or the repaint flashes Install between Installing and Play.
    await library.loadInstalled();
  }

  if (changed) signal.emit();
  announce(ended);
  schedule();
}

/**
 * Poll only while anything is running or queued. Queued counts because the backend
 * starts the next job off this poll.
 */
function schedule() {
  if (timer !== undefined) return;
  if (running().length === 0 && queued().length === 0) return;

  timer = setTimeout(() => void poll(), POLL_MS);
}

/** Read the jobs once and start polling if needed. Always emits, unlike the poll. */
export async function refresh() {
  const { ended } = apply(Object.values(await backend.GetJobs()));
  signal.emit();
  announce(ended);
  schedule();
}

/** Take a freshly started job on, without waiting for the next poll to see it. */
async function track(appName: string, job: Job | null) {
  if (!job) {
    // The runner may have started anyway, so ask what's actually running.
    console.warn("No job came back from the backend", { appName });
    try {
      await refresh();
    } catch (reason: unknown) {
      console.warn("Could not read the jobs back", reason);
    }
    return get(appName);
  }

  byAppName.set(appName, job);
  signal.emit();
  schedule();

  console.info(job.state === "queued" ? `Queued ${job.kind}` : `Started ${job.kind}`, { appName });
  return job;
}

/** Start or resume an install; comes back queued if another job is running. */
export async function install(appName: string, basePath?: string, gameFolder?: string) {
  return track(appName, await backend.StartInstall(appName, basePath, gameFolder));
}

/** Update an installed game to Epic's latest build. */
export async function update(appName: string) {
  return track(appName, await backend.StartUpdate(appName));
}

/**
 * Restart a paused job as what it was: an update re-run as an install could
 * reinstall from scratch if legendary rejects the partial download.
 */
export async function resume(appName: string) {
  return get(appName)?.kind === "update" ? update(appName) : install(appName);
}

export async function uninstall(appName: string) {
  return track(appName, await backend.StartUninstall(appName));
}

/** Pause everything of ours. What Steam's global "pause all downloads" maps to. */
export async function pauseAll() {
  // The queue too, or the backend starts the next job straight away.
  for (const job of [...running(), ...queued()]) await backend.PauseJob(job.app_name);
  await refresh();
}

export async function cancel(appName: string) {
  const cancelled = await backend.CancelJob(appName);
  await refresh();
  return cancelled;
}
