import { logger } from "../index";
import rpc, { type Job } from "../rpc";
import { createEmitter } from "./emitter";
import * as library from "./library";
import * as sizes from "./sizes";

// The frontend's view of the backend's installs. The backend can't push, so
// this polls, but only while something is running or queued - an idle Steam makes no
// calls at all. Everything that shows an install reads from here.

const POLL_MS = 1000;

const byAppName = new Map<string, Job>();

const emitter = createEmitter();
export const subscribe = emitter.subscribe;

let timer: ReturnType<typeof setTimeout> | undefined;

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

/** Waiting on the one legendary run the backend allows, oldest request first. */
export function queued(): Job[] {
  return [...byAppName.values()]
    .filter((job) => job.state === "queued")
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function paused(): Job[] {
  return [...byAppName.values()].filter((job) => job.state === "paused");
}

/** What the UI can tell apart: Steam draws the bar in whole percent. */
const shownPercent = (job: Job | undefined) =>
  job?.progress === undefined ? undefined : Math.round(job.progress.percent);

/**
 * Fold one poll's answer in, and report what came of it.
 *
 * `finished` is the transition worth acting on, since it's what changes whether
 * the game is installed. `changed` is whether a repaint would draw anything
 * different - a poll that saw the same percent as the last one shouldn't cost a
 * pass over every overview and a nudge to Steam's router.
 */
function apply(jobs: Job[]) {
  const finished: string[] = [];
  let changed = false;

  for (const job of jobs) {
    const previous = byAppName.get(job.appName);
    if (previous?.state === "running" && job.state !== "running") finished.push(job.appName);

    if (!previous || previous.state !== job.state || shownPercent(previous) !== shownPercent(job)) {
      changed = true;
    }

    byAppName.set(job.appName, job);
  }

  // A job that has vanished was cancelled, which leaves what it downloaded on
  // disk - so that counts as finishing too.
  const seen = new Set(jobs.map((job) => job.appName));
  for (const appName of byAppName.keys()) {
    if (seen.has(appName)) continue;
    byAppName.delete(appName);
    finished.push(appName);
    changed = true;
  }

  return { finished, changed };
}

async function poll() {
  timer = undefined;

  let jobs: Job[];
  try {
    jobs = await rpc.GetJobs();
  } catch (reason: unknown) {
    // One failed call shouldn't leave a dead poller behind mid-download.
    logger.warn("GetJobs failed", reason);
    schedule();
    return;
  }

  const { finished, changed } = apply(jobs);

  if (finished.length > 0) {
    // Whatever it was measured against has just been installed, updated or
    // deleted, so the "Space Required" we cached for it is no longer the truth.
    for (const appName of finished) sizes.forget(appName);

    // Before the emit: the job has stopped running but the library still says
    // the game isn't installed, and repainting in between flashes Install
    // between Installing and Play.
    await library.loadInstalled();
  }

  if (changed) emitter.emit();
  schedule();
}

/**
 * Keep polling while anything is running or waiting to, and stop when nothing
 * is. Idle is the normal state, and a timer firing every second behind an idle
 * Steam is how a plugin gets blamed for someone's frame rate.
 *
 * Queued counts: the backend starts the next job off this very poll, so letting
 * the timer stop with a queue behind it would leave it there forever.
 */
function schedule() {
  if (timer !== undefined) return;
  if (active().length === 0 && queued().length === 0) return;

  timer = setTimeout(() => void poll(), POLL_MS);
}

/**
 * Read the backend's jobs once, and start polling if any of them are running.
 * Emits either way, unlike the poll: this is called from the paths that have
 * just changed something and want the UI to say so.
 */
export async function refresh() {
  apply(await rpc.GetJobs());
  emitter.emit();
  schedule();
}

/** Take a freshly started job on, without waiting for the next poll to see it. */
async function track(appName: string, job: Job | undefined) {
  if (!job) {
    // The backend spawns the runner before it answers, so the install may be
    // underway with nothing watching it. Ask what is actually running.
    logger.warn("No job came back from the backend", { appName });
    try {
      await refresh();
    } catch (reason: unknown) {
      logger.warn("Could not read the jobs back", reason);
    }
    return get(appName);
  }

  byAppName.set(appName, job);
  emitter.emit();
  schedule();

  logger.info(job.state === "queued" ? `Queued ${job.kind}` : `Started ${job.kind}`, { appName });
  return job;
}

/**
 * Start, or resume, an install - legendary's `install` is both. Comes back
 * queued rather than running if one of ours is already going.
 */
export async function install(appName: string, basePath?: string, gameFolder?: string) {
  return track(appName, await rpc.StartInstall(appName, basePath, gameFolder));
}

/** Update an installed game to Epic's latest build. */
export async function update(appName: string) {
  return track(appName, await rpc.StartUpdate(appName));
}

/**
 * Restart a paused job as whatever it was. Resuming is re-running the command,
 * and an update re-run as a plain install would reinstall the game from nothing
 * the moment legendary decided the partial download wasn't usable.
 */
export async function resume(appName: string) {
  return get(appName)?.kind === "update" ? update(appName) : install(appName);
}

export async function uninstall(appName: string) {
  return track(appName, await rpc.StartUninstall(appName));
}

/** Stop an install, keeping the partial download. `install` resumes it. */
export async function pause(appName: string) {
  const stopped = await rpc.PauseJob(appName);
  await refresh();
  return stopped;
}

/** Pause everything of ours. What Steam's global "pause all downloads" maps to. */
export async function pauseAll() {
  // The queue too, or "pause all downloads" stops the one that's running and
  // the backend immediately starts the next.
  for (const job of [...active(), ...queued()]) await rpc.PauseJob(job.appName);
  await refresh();
}

export async function cancel(appName: string) {
  const cancelled = await rpc.CancelJob(appName);
  await refresh();
  return cancelled;
}
