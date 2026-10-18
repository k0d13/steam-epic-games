import * as appIds from "../state/app-ids";
import * as jobs from "../state/jobs";
import { bytesFor, etaSeconds, PROGRESS_DOWNLOAD } from "./downloads";

// The app page's bar reads the client's single download overview, not the tile's
// `status_percentage`. We only claim it while Steam isn't downloading anything itself.
//
// The bottom bar only re-renders when the store hands it a new overview, as Steam's
// own updates do, so each change is written to a copy that replaces the old one.

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
  /** Overviews by client, observable; the local one is under the local client's id. */
  m_DownloadOverview?: Map<unknown, DownloadOverview>;
}

function getStore(): DownloadsStore | undefined {
  return Reflect.get(globalThis, "downloadsStore") as DownloadsStore | undefined;
}

function getOverview(): DownloadOverview | undefined {
  return getStore()?.LocalDownloadOverview;
}

/**
 * Write `change` to a copy of the local overview and put it in the store, so
 * everything observing it re-renders. Edits in place if the map has moved.
 */
function publish(overview: DownloadOverview, change: (copy: DownloadOverview) => void) {
  const overviews = getStore()?.m_DownloadOverview;
  const key = overviews && [...overviews].find(([, value]) => value === overview)?.[0];
  if (!overviews || key === undefined) {
    change(overview);
    return;
  }

  const copy = { ...overview, progress: overview.progress?.map((stage) => ({ ...stage })) };
  change(copy);
  overviews.set(key, copy);
}

/** The appid we last wrote, so we know whether an occupied overview is ours. */
let claimed: number | undefined;

/** Point the download overview at our running install, or release it. Runs every jobs tick. */
export function sync() {
  const overview = getOverview();
  if (!overview) return;

  const job = jobs.running().find(jobs.isDownload);
  const appId = job && appIds.getAppId(job.app_name);

  if (job && appId !== undefined) {
    // Steam's own download wins; ours waits for the app page's bar.
    if (overview.update_appid !== 0 && overview.update_appid !== claimed) return;

    claimed = appId;
    publish(overview, (copy) => {
      copy.update_appid = appId;
      copy.update_state = "Downloading";
      // What the downloads page labels the row with: an update isn't an install.
      copy.update_is_install = job.kind === "install";
      copy.update_is_upload = false;
      copy.paused = false;
      copy.overall_percent_complete = job.progress?.percent ?? 0;
      copy.overall_estimated_time_remaining_sec = etaSeconds(job.progress?.eta);
      copy.update_network_bytes_per_second = (job.progress?.speed ?? 0) * MIB;

      // The downloads page's active row prints these as "x of y".
      const stage = copy.progress?.[PROGRESS_DOWNLOAD];
      if (stage) {
        [stage.bytes_in_progress, stage.bytes_total] = bytesFor(job);
        stage.estimated_time_remaining_sec = copy.overall_estimated_time_remaining_sec;
      }
    });
    return;
  }

  release();
}

/** Give the overview back, for an unload that happens mid-install. */
export function release() {
  const overview = getOverview();
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
