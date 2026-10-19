import * as library from "./library";
import { createSignal } from "./primitives";
import * as sizes from "./sizes";

// The backend can't push, so this polls, but only while a job is running or queued

const POLL_MS = 1000;

const byAppName = new Map<string, Job>();

const signal = createSignal();
export const subscribe = signal.subscribe;

// A job that ran to the end, done or failed; not a pause or a cancel
const ended = createSignal<Job>();
export const onEnded = ended.subscribe;

let timer: ReturnType<typeof setTimeout> | undefined;

export function get(appName: string) {
  return byAppName.get(appName);
}

function inState(state: string) {
  return [...byAppName.values()].filter((job) => job.state === state);
}

// A list, since the backend can't promise one running job
export function running() {
  return inState("running");
}
export function queued() {
  return inState("queued").sort((a, b) => a.started_at - b.started_at);
}
export function paused() {
  return inState("paused");
}

// Downloads show on the downloads page, uninstalls don't
export function isDownload(job: Job) {
  return job.kind === "install" || job.kind === "update";
}

// Steam draws the bar in whole percent
function shownPercent(job: Job | undefined) {
  return job?.progress ? Math.round(job.progress.percent) : undefined;
}

// `finished` games change whether they're installed, `changed` is false when a repaint draws nothing new
function apply(jobs: Job[]) {
  const finished: string[] = [];
  const endedJobs: Job[] = [];
  let changed = false;

  for (const job of jobs) {
    const previous = byAppName.get(job.app_name);
    const wasRunning = previous?.state === "running";
    if (wasRunning && job.state !== "running") finished.push(job.app_name);
    if (wasRunning && (job.state === "done" || job.state === "failed")) endedJobs.push(job);

    if (!previous || previous.state !== job.state || shownPercent(previous) !== shownPercent(job)) {
      changed = true;
    }

    byAppName.set(job.app_name, job);
  }

  // A vanished job was cancelled, leaving its download on disk, so it counts as finished
  const seen = new Set(jobs.map((job) => job.app_name));
  for (const appName of byAppName.keys()) {
    if (seen.has(appName)) continue;
    byAppName.delete(appName);
    finished.push(appName);
    changed = true;
  }

  return { finished, ended: endedJobs, changed };
}

function announce(jobs: Job[]) {
  return jobs.forEach(ended.emit);
}

// Lua sends {} for an empty list; Object.values reads both
async function fetchJobs() {
  return Object.values(await backend.GetJobs());
}

async function poll() {
  timer = undefined;

  let jobs: Job[];
  try {
    jobs = await fetchJobs();
  } catch (reason: unknown) {
    // One failed call shouldn't leave a dead poller behind mid-download
    console.warn("GetJobs failed", reason);
    schedule();
    return;
  }

  const { finished, ended, changed } = apply(jobs);

  if (finished.length > 0) {
    // The cached "Space Required" predates whatever this job just did
    for (const appName of finished) sizes.forget(appName);

    // Before the emit, or the repaint flashes Install between Installing and Play
    await library.loadInstalled();
  }

  if (changed) signal.emit();
  announce(ended);
  schedule();
}

// Queued counts as active because the backend starts the next job off this poll
function schedule() {
  if (timer !== undefined || (running().length === 0 && queued().length === 0)) return;
  timer = setTimeout(() => void poll(), POLL_MS);
}

// Unlike the poll, always emits
export async function refresh() {
  const { ended } = apply(await fetchJobs());
  signal.emit();
  announce(ended);
  schedule();
}

// Takes a freshly started job on without waiting for the next poll to see it
async function track(appName: string, job: Job | null) {
  if (!job) {
    // The runner may have started anyway, so ask what's actually running
    console.warn("No job came back from the backend", { appName });
    await refresh().catch((reason: unknown) =>
      console.warn("Could not read the jobs back", reason),
    );
    return get(appName);
  }

  byAppName.set(appName, job);
  signal.emit();
  schedule();

  console.info(job.state === "queued" ? `Queued ${job.kind}` : `Started ${job.kind}`, { appName });
  return job;
}

// Comes back queued if another job is running
export async function install(appName: string, basePath?: string, gameFolder?: string) {
  return track(appName, await backend.StartInstall(appName, basePath, gameFolder));
}

export async function update(appName: string) {
  return track(appName, await backend.StartUpdate(appName));
}

export async function uninstall(appName: string) {
  return track(appName, await backend.StartUninstall(appName));
}

// An update re-run as an install could reinstall from scratch if legendary rejects the partial download
export function resume(appName: string) {
  return get(appName)?.kind === "update" ? update(appName) : install(appName);
}

export async function pauseAll() {
  // The queue too, or the backend starts the next job straight away
  for (const job of [...running(), ...queued()]) await backend.PauseJob(job.app_name);
  await refresh();
}

export async function cancel(appName: string) {
  const cancelled = await backend.CancelJob(appName);
  await refresh();
  return cancelled;
}
