import { logger } from "../index";
import rpc, { type Job } from "../rpc";
import * as library from "./library";

// The frontend's view of the backend's installs. The backend can't push, so
// this polls - but only while something is actually running, so an idle Steam
// makes no calls at all.
//
// Everything that shows an install reads from here: the install state patch
// turns a running job into Steam's own progress bar, and the panel lists them.

const POLL_MS = 1000;

const byAppName = new Map<string, Job>();

const listeners = new Set<() => void>();

let timer: ReturnType<typeof setTimeout> | undefined;

function notify() {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current job for one game, running or finished, if it has ever had one. */
export function get(appName: string): Job | undefined {
  return byAppName.get(appName);
}

/** The job for a Steam appid, for the patches, which only ever have one of those. */
export function getByAppId(appId: number): Job | undefined {
  const game = library.getByAppId(appId);
  return game && byAppName.get(game.appName);
}

export function active(): Job[] {
  return [...byAppName.values()].filter((job) => job.state === "running");
}

export function paused(): Job[] {
  return [...byAppName.values()].filter((job) => job.state === "paused");
}

/**
 * Fold one poll's answer in, and report whether anything finished.
 *
 * Finishing is the only transition worth acting on: it's what changes whether
 * the game is installed, which is a different question from how the download is
 * going and costs a call to legendary to answer.
 */
function apply(jobs: Job[]) {
  let finished = false;

  for (const job of jobs) {
    const previous = byAppName.get(job.appName);
    if (previous && previous.state === "running" && job.state !== "running") finished = true;
    byAppName.set(job.appName, job);
  }

  // A job that has vanished from the backend was cancelled, and cancelling
  // leaves whatever it had already written on disk - so that counts too.
  const seen = new Set(jobs.map((job) => job.appName));
  for (const appName of byAppName.keys()) {
    if (seen.has(appName)) continue;
    byAppName.delete(appName);
    finished = true;
  }

  return finished;
}

async function poll() {
  timer = undefined;

  let jobs: Job[];
  try {
    jobs = await rpc.GetJobs();
  } catch (reason: unknown) {
    // The backend going quiet mid-download shouldn't leave a dead poller
    // behind: try again on the next tick rather than giving up on the install.
    logger.warn("GetJobs failed", reason);
    schedule();
    return;
  }

  const finished = apply(jobs);
  notify();

  if (finished) {
    // Only the installed half can have changed, so this is the cheap refresh -
    // and it repaints the tile through the library's own listeners.
    await library.loadInstalled();
  }

  schedule();
}

/**
 * Keep polling while anything is running, and stop when nothing is. Idle is the
 * normal state, and a timer firing every second forever behind a Steam that
 * isn't downloading anything is exactly the kind of thing that gets a plugin
 * blamed for someone's frame rate.
 */
function schedule() {
  if (timer !== undefined) return;
  if (active().length === 0) return;

  timer = setTimeout(() => void poll(), POLL_MS);
}

/** Read the backend's jobs once, and start polling if any of them are running. */
export async function refresh() {
  const jobs = await rpc.GetJobs();
  apply(jobs);
  notify();
  schedule();
}

/**
 * Start, or resume, an install. legendary's `install` is both - pointed at a
 * partial download it continues from where it stopped.
 */
export async function install(appName: string, basePath?: string, gameFolder?: string) {
  const job = await rpc.StartInstall(appName, basePath, gameFolder);
  if (!job) return undefined;

  byAppName.set(appName, job);
  notify();
  schedule();

  logger.info("Installing", { appName, basePath });
  return job;
}

export async function uninstall(appName: string) {
  const job = await rpc.StartUninstall(appName);
  if (!job) return undefined;

  byAppName.set(appName, job);
  notify();
  schedule();

  return job;
}

/** Stop an install, keeping the partial download. `install` resumes it. */
export async function pause(appName: string) {
  const stopped = await rpc.PauseJob(appName);
  await refresh();
  return stopped;
}

/** Pause everything of ours. What Steam's global "pause all downloads" maps to. */
export async function pauseAll() {
  for (const job of active()) await rpc.PauseJob(job.appName);
  await refresh();
}

export async function cancel(appName: string) {
  const cancelled = await rpc.CancelJob(appName);
  await refresh();
  return cancelled;
}
