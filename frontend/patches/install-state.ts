import { beforePatch, EDisplayStatus } from "@steambrew/client";
import { forceFakeLocationChange, NON_STEAM_APP_APPID_MASK, Steam } from "steambrew-utils";
import { logger } from "../index";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// This is the whole trick.
//
// A non-Steam shortcut is installed by definition, so left alone every Epic
// game claims to be: a Play button for a game that isn't there, and every
// "Installed" filter and automatic collection full of them.
//
// CollectionStore.OnAppOverviewChange is the funnel every overview passes
// through before the grid, the filters and the sort read it, so correcting
// install state there gets all three natively.

let verified = false;

/**
 * States Steam sets while it is running the shortcut itself. The game is
 * installed either way, and overwriting them with ReadyToLaunch leaves the play
 * bar offering Play for a game that's already open.
 */
const RUNNING_STATUSES = new Set<number>([
  EDisplayStatus.Launching,
  EDisplayStatus.Running,
  EDisplayStatus.Terminating,
]);

/** The overview fields we write. None of them are in @steambrew/client's typings. */
interface PerClientData {
  installed?: boolean;
  display_status?: number;
  status_percentage?: number;
}

interface MutableOverview {
  appid: number;
  local_per_client_data?: PerClientData;
  per_client_data?: PerClientData[];
  size_on_disk?: string;
}

/**
 * Rewrite one overview to match what Epic says. Install state lives in three
 * places that have to agree: `local_per_client_data` drives the app page, the
 * `per_client_data` array drives the grid tile, and `size_on_disk` is what the
 * filters and collections test.
 */
function applyInstallState(overview: Steam.AppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game) return;

  const app = overview as unknown as MutableOverview;

  // Steam derives the whole install UI from these two fields, so a running job
  // needs no UI of its own. `Downloading` rather than `Installing` because it's
  // the status the progress bar reads a percentage for; Installing draws an
  // indeterminate spinner.
  const job = jobs.get(game.appName);
  const downloading =
    job?.kind === "install" && (job.state === "running" || job.state === "paused");
  // An uninstall is a directory delete, so there's no percentage to show.
  const uninstalling = job?.kind === "uninstall" && job.state === "running";

  for (const data of [app.local_per_client_data, ...(app.per_client_data ?? [])]) {
    if (!data) continue;

    if (uninstalling) {
      // Still installed until the delete finishes, or it leaves the Installed
      // collection while it's still on disk.
      data.installed = true;
      data.display_status = EDisplayStatus.Uninstalling;
      data.status_percentage = 0;
      continue;
    }

    if (downloading) {
      data.installed = false;
      data.display_status =
        job.state === "paused" ? EDisplayStatus.DownloadPaused : EDisplayStatus.Downloading;
      data.status_percentage = job.progress?.percent ?? 0;
      continue;
    }

    data.installed = game.installed;
    if (!(game.installed && RUNNING_STATUSES.has(data.display_status ?? 0))) {
      data.display_status = game.installed
        ? EDisplayStatus.ReadyToLaunch
        : EDisplayStatus.ReadyToInstall;
    }
    data.status_percentage = 0;
  }

  if (downloading) {
    // No `size_on_disk`: a half-downloaded game would join the Installed
    // collection mid-download.
    app.size_on_disk = undefined;
    return;
  }

  // The Installed collection tests this rather than the per-client flags, so
  // leaving it set shows an uninstalled game there anyway.
  app.size_on_disk = game.installed ? `${game.installSize ?? 0}` : undefined;

  if (!verified) {
    verified = true;
    logger.debug("Install state patch applied", {
      appId: app.appid,
      appName: game.appName,
      wanted: game.installed,
      // Different from `wanted` means these are read-only on this Steam build
      // and none of it is taking effect.
      gotLocal: app.local_per_client_data?.installed,
      gotSize: app.size_on_disk,
    });
  }
}

export function register() {
  const patch = beforePatch(
    Steam.CollectionStore,
    "OnAppOverviewChange",
    ([apps]: [Steam.AppOverview[]]) => {
      for (const app of apps) {
        if (app.appid < NON_STEAM_APP_APPID_MASK) continue;
        applyInstallState(app);
      }
    },
  );

  logger.debug("Registered the install state patch");
  return patch.unpatch;
}

/**
 * Correct the overviews Steam has already built and get the UI to redraw them,
 * since Steam builds them before the library has loaded.
 *
 * Don't hand the apps back to OnAppOverviewChange: that's Steam's inbound path
 * for freshly deserialized overviews, and calling it with the store's own
 * objects throws "t is not iterable" out of UpdateApps.
 */
export function refreshAll() {
  const apps = Steam.AppStore.allApps.filter(
    (app) => app.appid >= NON_STEAM_APP_APPID_MASK && library.getByAppId(app.appid) !== undefined,
  );

  if (apps.length === 0) return;

  for (const app of apps) applyInstallState(app);

  forceFakeLocationChange();
  logger.debug("Refreshed the Epic overviews", { count: apps.length });
}
