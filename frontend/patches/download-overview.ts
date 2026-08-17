import { logger } from "../index";
import * as appIds from "../state/app-ids";
import * as jobs from "../state/jobs";

// The app page's progress bar does not come from the overview's
// `status_percentage`, whatever the tile in the grid does.
//
//   GetProgressBarPct() {
//     if (LocalDownloadOverview.update_appid == appid) return overall_percent_complete;
//     const item = GetDownloadItemForOverview(overview);
//     if (item) return percent(item);
//     switch (selected_per_client_data.display_status) {
//       case DownloadQueued: case UpdateQueued: case DownloadPaused:
//       case UpdatePaused: case DownloadRequired: case UpdateRequired:
//         return selected_per_client_data.status_percentage;
//     }
//     return -1;
//   }
//
// `Downloading` and `Updating` are deliberately missing from that switch: a game
// that is actively downloading has its numbers in the client's download
// overview, so Steam reads them from there. With the status set and nothing
// else, `BIsDownloading()` is true - hence the "Downloading" label - while the
// percentage is -1 and no bar is drawn. Writing the overview is what completes
// it, and it gives us Steam's "Downloading 12%" detail text for free.
//
// `DownloadOverview` is one object for the whole client, driving the downloads
// page header and the currently-downloading highlight. Claiming it while Steam
// is downloading something of its own would show our numbers against their
// game, so we take it only when it's idle, and hand it back when we're done.

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

let verified = false;

/**
 * Point the client's download overview at whichever of our installs is running,
 * or release it once none is.
 *
 * Called on every jobs tick, which is also what repaints the page - so this is
 * the only thing that has to keep the numbers current.
 */
export function sync() {
  const overview = getOverview();
  if (!overview) return;

  const job = jobs.active().find((candidate) => candidate.kind === "install");
  const appId = job && appIds.getAppId(job.appName);

  if (job && appId !== undefined) {
    // Steam's own download wins. Ours still has its status and its tile
    // progress, it just doesn't get the app page's bar until Steam is finished.
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

    if (!verified) {
      verified = true;
      logger.debug("Claimed the download overview", {
        appId,
        appName: job.appName,
        // Different from what we wrote means the overview is read-only on this
        // Steam build and the app page's progress bar will stay empty.
        got: overview.update_appid,
      });
    }
    return;
  }

  if (claimed === undefined || overview.update_appid !== claimed) return;

  claimed = undefined;
  overview.update_appid = 0;
  overview.update_state = "None";
  overview.update_is_install = false;
  overview.overall_percent_complete = 0;
  overview.overall_estimated_time_remaining_sec = -1;
  overview.update_network_bytes_per_second = 0;
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
  overview.update_network_bytes_per_second = 0;
}
