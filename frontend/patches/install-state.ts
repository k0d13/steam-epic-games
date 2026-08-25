import { beforePatch, EDisplayStatus, type SteamAppOverview } from "@steambrew/client";
import { logger } from "../index";
import { once } from "../services/once";
import { forceFakeLocationChange } from "../services/popups";
import { NON_STEAM_APP_APPID_MASK } from "../state/app-ids";
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

const logApplied = once((app: MutableOverview, appName: string, wanted: boolean) => {
  logger.debug("Install state patch applied", {
    appId: app.appid,
    appName,
    wanted,
    // Different from `wanted` means these are read-only on this Steam build and
    // none of it is taking effect.
    gotLocal: app.local_per_client_data?.installed,
    gotSize: app.size_on_disk,
  });
});

/**
 * Rewrite one overview to match what Epic says. Install state lives in three
 * places that have to agree: `local_per_client_data` drives the app page, the
 * `per_client_data` array drives the grid tile, and `size_on_disk` is what the
 * filters and collections test.
 */
function applyInstallState(overview: SteamAppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game) return;

  const app = overview as unknown as MutableOverview;

  // Steam derives the whole install UI from these two fields, so a running job
  // needs no UI of its own. `Downloading` rather than `Installing` because it's
  // the status the progress bar reads a percentage for; Installing draws an
  // indeterminate spinner.
  const job = jobs.get(game.appName);
  const pending = job?.state === "running" || job?.state === "paused" || job?.state === "queued";
  const downloading = job?.kind === "install" && pending;
  // An uninstall is a directory delete, so there's no percentage to show. A
  // queued one still says Uninstalling: it is going to happen, and there is no
  // other status that means "about to lose these files".
  const uninstalling = job?.kind === "uninstall" && pending;

  // Defensive about the array: everything else in this file finds Steam's
  // shapes rather than trusting them, and a spread is what turns a field that
  // isn't a list on some build into a thrown TypeError on the render path.
  const perClient = Array.isArray(app.per_client_data) ? app.per_client_data : [];

  for (const data of [app.local_per_client_data, ...perClient]) {
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
      if (job.state === "paused") data.display_status = EDisplayStatus.DownloadPaused;
      else if (job.state === "queued") data.display_status = EDisplayStatus.DownloadQueued;
      else data.display_status = EDisplayStatus.Downloading;
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

  logApplied(app, game.appName, game.installed);
}

export function register() {
  const patch = beforePatch(
    collectionStore,
    "OnAppOverviewChange",
    ([apps]: [SteamAppOverview[]]) => {
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
  const apps = appStore.allApps.filter(
    (app) => app.appid >= NON_STEAM_APP_APPID_MASK && library.getByAppId(app.appid) !== undefined,
  );

  if (apps.length === 0) return;

  for (const app of apps) applyInstallState(app);

  forceFakeLocationChange();
  logger.debug("Refreshed the Epic overviews", { count: apps.length });
}
