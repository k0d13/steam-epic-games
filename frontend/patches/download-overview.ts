import { logger } from "../index";
import { once } from "../services/once";
import * as appIds from "../state/app-ids";
import * as jobs from "../state/jobs";

// The app page's progress bar doesn't come from the overview's
// `status_percentage`, whatever the grid tile does. For a game that is actively
// downloading, Steam reads the percentage out of the client's download overview
// instead - so with only the status set, the page says "Downloading" and draws
// no bar at all. Writing the overview completes it, and gives us Steam's
// "Downloading 12%" detail text for free.
//
// There is one of these for the whole client, and it also drives the downloads
// page. Claiming it while Steam is downloading something of its own would show
// our numbers against their game, so we take it only when it's idle.

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
}

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
  logger.debug("Claimed the download overview", {
    appId,
    appName,
    // Different from what we wrote means it's read-only on this build and the
    // app page's bar will stay empty.
    got: overview.update_appid,
  });
});

/**
 * Point the client's download overview at whichever of our installs is running,
 * or release it once none is. Called on every jobs tick, which is also what
 * repaints the page.
 */
export function sync() {
  const overview = getOverview();
  if (!overview) return;

  const job = jobs.active().find((candidate) => candidate.kind === "install");
  const appId = job && appIds.getAppId(job.appName);

  if (job && appId !== undefined) {
    // Steam's own download wins. Ours keeps its status and its tile progress,
    // it just doesn't get the app page's bar until Steam has finished.
    if (overview.update_appid !== 0 && overview.update_appid !== claimed) return;

    claimed = appId;
    overview.update_appid = appId;
    overview.update_state = "Downloading";
    overview.update_is_install = true;
    overview.update_is_upload = false;
    overview.paused = false;
    overview.overall_percent_complete = job.progress?.percent ?? 0;
    overview.overall_estimated_time_remaining_sec = -1;
    overview.update_network_bytes_per_second = job.progress?.speed ?? 0;

    logClaimed(overview, appId, job.appName);
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
}
