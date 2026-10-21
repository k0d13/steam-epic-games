import * as appIds from "../../state/app-ids";
import * as jobs from "../../state/jobs";
import { bytesFor, etaSeconds, PROGRESS_DOWNLOAD } from "./downloads";

// The app page's bar reads the client's single download overview, not the tile's
// `status_percentage`, and we only claim it while Steam isn't downloading anything
// itself. The bottom bar only re-renders when the store hands it a new overview, as
// Steam's own updates do, so each change is written to a copy that replaces the old one

// legendary reports MiB/s and Steam wants bytes
const MIB = 1024 * 1024;

// The appid we last wrote, so we know whether an occupied overview is ours
let claimed: number | undefined;

// Edits in place if the overview map has moved
function publish(overview: DownloadOverview, change: (copy: DownloadOverview) => void) {
  const overviews = globalThis.downloadsStore?.m_DownloadOverview;
  const key = overviews && [...overviews].find(([, value]) => value === overview)?.[0];
  if (!overviews || key === undefined) {
    change(overview);
    return;
  }

  const copy = { ...overview, progress: overview.progress?.map((stage) => ({ ...stage })) };
  change(copy);
  overviews.set(key, copy);
}

// Points the overview at our running install, or releases it; runs every jobs tick
export function sync() {
  const overview = globalThis.downloadsStore?.LocalDownloadOverview;
  if (!overview) return;

  // A verify is Validating in Steam's bottom bar, as it is for a Steam game
  const job = jobs
    .running()
    .find((running) => jobs.isDownload(running) || running.kind === "verify");
  const appId = job && appIds.getAppId(job.app_name);

  if (!job || appId === undefined) {
    release();
    return;
  }

  // Steam's own download wins, and ours waits for the app page's bar
  if (overview.update_appid !== 0 && overview.update_appid !== claimed) return;

  claimed = appId;
  publish(overview, (copy) => {
    copy.update_appid = appId;
    copy.update_state = job.kind === "verify" ? "Validating" : "Downloading";
    // What the downloads page labels the row with, since an update isn't an install
    copy.update_is_install = job.kind === "install";
    copy.update_is_upload = false;
    copy.paused = false;
    copy.overall_percent_complete = job.progress?.percent ?? 0;
    copy.overall_estimated_time_remaining_sec = etaSeconds(job.progress?.eta);
    // A verify's speed is the disk's, not a download's
    copy.update_network_bytes_per_second =
      job.kind === "verify" ? 0 : (job.progress?.speed ?? 0) * MIB;

    // The downloads page's active row prints these as "x of y"
    const stage = copy.progress?.[PROGRESS_DOWNLOAD];
    if (stage && jobs.isDownload(job)) {
      [stage.bytes_in_progress, stage.bytes_total] = bytesFor(job);
      stage.estimated_time_remaining_sec = copy.overall_estimated_time_remaining_sec;
    }
  });
}

// Also for an unload that happens mid-install
export function release() {
  const overview = globalThis.downloadsStore?.LocalDownloadOverview;
  if (!overview || claimed === undefined || overview.update_appid !== claimed) return;

  claimed = undefined;
  publish(overview, (copy) => {
    copy.update_appid = 0;
    copy.update_state = "None";
    copy.update_is_install = false;
    copy.overall_percent_complete = 0;
    copy.overall_estimated_time_remaining_sec = -1;
    copy.update_network_bytes_per_second = 0;

    const stage = copy.progress?.[PROGRESS_DOWNLOAD];
    if (stage) {
      stage.bytes_in_progress = 0;
      stage.bytes_total = 0;
      stage.estimated_time_remaining_sec = -1;
    }
  });
}
