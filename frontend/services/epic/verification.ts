import * as jobs from "../../state/jobs";

// legendary exits 0 after finding bad files, so the backend fails the job instead and
// its error holds the summary: "Verification failed, 3 file(s) corrupted, 1 file(s) are missing."
const FAILURE = /(\d+) file\(s\) corrupted, (\d+) file\(s\) are missing/;

// Files each game's repair is replacing, for the page's message
const found = new Map<string, number>();

export function reacquiring(appName: string) {
  return found.get(appName);
}

// How many files a failed verify found wrong, or nothing if it failed for another reason
export function badFiles(job: Job) {
  const match = FAILURE.exec(job.error ?? "");
  return match ? Number(match[1]) + Number(match[2]) : undefined;
}

// Steam's verify reacquires what it finds wrong, so a failed one goes straight on to a repair
export function onVerified(job: Job) {
  const count = badFiles(job);
  if (job.state !== "failed" || count === undefined) return;

  found.set(job.app_name, count);
  void jobs.repair(job.app_name);
}
