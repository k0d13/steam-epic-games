import { once } from "../services/once";
import * as appIds from "../state/app-ids";
import * as jobs from "../state/jobs";
import { bytesFor, etaSeconds, PROGRESS_DOWNLOAD } from "./downloads";

// The app page's bar reads the client's single download overview, not the tile's
// `status_percentage`. We only claim it while Steam isn't downloading anything itself.

/** Only the fields we touch; the real overview carries several dozen. */
interface DownloadOverview {
  update_appid: number;
  update_state: string;
  update_is_install: boolean;
  update_is_upload: boolean;
  overall_percent_complete: number;
  overall_estimated_time_remaining_sec: number;
  update_network_bytes_per_second: number;
  paused: boolean;
  /** One entry per EAppUpdateProgress stage; the downloads page reads Download. */
  progress?: {
    bytes_in_progress: number;
    bytes_total: number;
    estimated_time_remaining_sec: number;
  }[];
}

/** legendary reports MiB/s; Steam wants bytes. */
const MIB = 1024 * 1024;

interface DownloadsStore {
  LocalDownloadOverview?: DownloadOverview;
}

function getOverview(): DownloadOverview | undefined {
  const store = Reflect.get(globalThis, "downloadsStore") as DownloadsStore | undefined;
  return store?.LocalDownloadOverview;
}

/** The appid we last wrote, so we know whether an occupied overview is ours. */
let claimed: number | undefined;

const logClaimed = once((overview: DownloadOverview, appId: number, appName: string) => {
  console.debug("Claimed the download overview", {
    appId,
    appName,
    // A mismatch means it's read-only on this build.
    got: overview.update_appid,
  });
});

/** Point the download overview at our running install, or release it. Runs every jobs tick. */
export function sync() {
  const overview = getOverview();
  if (!overview) return;

  const job = jobs
    .active()
    .find((candidate) => candidate.kind === "install" || candidate.kind === "update");
  const appId = job && appIds.getAppId(job.app_name);

  if (job && appId !== undefined) {
    // Steam's own download wins; ours waits for the app page's bar.
    if (overview.update_appid !== 0 && overview.update_appid !== claimed) return;

    claimed = appId;
    overview.update_appid = appId;
    overview.update_state = "Downloading";
    // What the downloads page labels the row with: an update isn't an install.
    overview.update_is_install = job.kind === "install";
    overview.update_is_upload = false;
    overview.paused = false;
    overview.overall_percent_complete = job.progress?.percent ?? 0;
    overview.overall_estimated_time_remaining_sec = etaSeconds(job.progress?.eta);
    overview.update_network_bytes_per_second = (job.progress?.speed ?? 0) * MIB;

    // The downloads page's active row prints these as "x of y".
    const stage = overview.progress?.[PROGRESS_DOWNLOAD];
    if (stage) {
      [stage.bytes_in_progress, stage.bytes_total] = bytesFor(job);
      stage.estimated_time_remaining_sec = overview.overall_estimated_time_remaining_sec;
    }

    logClaimed(overview, appId, job.app_name);
    return;
  }

  release();
}

/** Give the overview back, for an unload that happens mid-install. */
export function release() {
  const overview = getOverview();
  if (!overview || claimed === undefined || overview.update_appid !== claimed) return;

  claimed = undefined;
  overview.update_appid = 0;
  overview.update_state = "None";
  overview.update_is_install = false;
  overview.overall_percent_complete = 0;
  overview.overall_estimated_time_remaining_sec = -1;
  overview.update_network_bytes_per_second = 0;

  const stage = overview.progress?.[PROGRESS_DOWNLOAD];
  if (stage) {
    stage.bytes_in_progress = 0;
    stage.bytes_total = 0;
    stage.estimated_time_remaining_sec = -1;
  }
}
