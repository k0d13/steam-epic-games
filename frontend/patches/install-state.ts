import { beforePatch, EDisplayStatus, type SteamAppOverview } from "millennium";
import { once } from "../services/once";
import { forceFakeLocationChange } from "../services/popups";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// Shortcuts always count as installed. Every overview passes through
// OnAppOverviewChange before the grid, filters and sort, so we correct it there.

/** Steam's running states, which ReadyToLaunch would turn back into a Play button. */
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
  console.debug("Install state patch applied", {
    appId: app.appid,
    appName,
    wanted,
    // A mismatch with `wanted` means these are read-only on this build.
    gotLocal: app.local_per_client_data?.installed,
    gotSize: app.size_on_disk,
  });
});

/**
 * Rewrite one overview to match Epic. `local_per_client_data` drives the app page,
 * `per_client_data` the grid tile, and `size_on_disk` the filters and collections.
 */
function applyInstallState(overview: SteamAppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game) return;

  const app = overview as unknown as MutableOverview;

  // Steam draws the whole install UI from these. `Downloading`, not `Installing`,
  // since only it gets a percentage bar.
  const job = jobs.get(game.app_name);
  const pending = job?.state === "running" || job?.state === "paused" || job?.state === "queued";
  const downloading = job?.kind === "install" && pending;
  // The old build stays launchable until the new one lands.
  const updating = job?.kind === "update" && pending;
  // No percentage for a delete. Queued still says Uninstalling, as nothing else fits.
  const uninstalling = job?.kind === "uninstall" && pending;

  // Not trusted to be an array: spreading anything else throws on the render path.
  const perClient = Array.isArray(app.per_client_data) ? app.per_client_data : [];

  for (const data of [app.local_per_client_data, ...perClient]) {
    if (!data) continue;

    if (uninstalling) {
      // Still on disk until the delete finishes, so it stays in Installed.
      data.installed = true;
      data.display_status = EDisplayStatus.Uninstalling;
      data.status_percentage = 0;
      continue;
    }

    if (updating) {
      data.installed = true;
      if (job.state === "paused") data.display_status = EDisplayStatus.UpdatePaused;
      else if (job.state === "queued") data.display_status = EDisplayStatus.UpdateQueued;
      else data.display_status = EDisplayStatus.Updating;
      data.status_percentage = job.progress?.percent ?? 0;
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
      // UpdateRequired turns Play into Update, the only place needs_update shows.
      if (!game.installed) data.display_status = EDisplayStatus.ReadyToInstall;
      else if (game.needs_update) data.display_status = EDisplayStatus.UpdateRequired;
      else data.display_status = EDisplayStatus.ReadyToLaunch;
    }
    data.status_percentage = 0;
  }

  if (downloading) {
    // No `size_on_disk`, or a half-downloaded game joins Installed.
    app.size_on_disk = undefined;
    return;
  }

  // The Installed collection tests this, not the per-client flags.
  app.size_on_disk = game.installed ? `${game.install_size ?? 0}` : undefined;

  logApplied(app, game.app_name, game.installed);
}

export function register() {
  const patch = beforePatch(
    collectionStore,
    "OnAppOverviewChange",
    ([apps]: [SteamAppOverview[]]) => {
      for (const app of apps) applyInstallState(app);
    },
  );

  console.debug("Registered the install state patch");
  return patch.unpatch;
}

/**
 * Correct overviews Steam built before the library loaded. Not through
 * OnAppOverviewChange, which throws "t is not iterable" on the store's own objects.
 */
export function refreshAll() {
  const apps = library.overviews();
  if (apps.length === 0) return;

  for (const app of apps) applyInstallState(app);

  forceFakeLocationChange();
  console.debug("Refreshed the Epic overviews", { count: apps.length });
}
