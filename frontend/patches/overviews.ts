import { beforePatch, EDisplayStatus, type SteamAppOverview } from "millennium";
import { forceFakeLocationChange } from "../services/popups";
import * as info from "../state/info";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import { categoriesFor } from "./game-info";

// Steam's overviews draw the library: tiles, filters, sort and the app page. Every
// one passes through OnAppOverviewChange first, so ours are corrected there.

/** Steam's running states, which ReadyToLaunch would turn back into a Play button. */
const RUNNING_STATUSES = new Set<number>([
  EDisplayStatus.Launching,
  EDisplayStatus.Running,
  EDisplayStatus.Terminating,
]);

/** What a running, paused and queued job of each kind shows. A delete has one status. */
const JOB_STATUSES: Record<string, number[]> = {
  // Downloading, not Installing, since only it gets a percentage bar.
  install: [
    EDisplayStatus.Downloading,
    EDisplayStatus.DownloadPaused,
    EDisplayStatus.DownloadQueued,
  ],
  update: [EDisplayStatus.Updating, EDisplayStatus.UpdatePaused, EDisplayStatus.UpdateQueued],
  uninstall: [
    EDisplayStatus.Uninstalling,
    EDisplayStatus.Uninstalling,
    EDisplayStatus.Uninstalling,
  ],
};

/** The overview fields we write. None of them are in @steambrew/client's typings. */
interface PerClientData {
  installed?: boolean;
  display_status?: number;
  status_percentage?: number;
}

interface MutableOverview {
  local_per_client_data?: PerClientData;
  per_client_data?: PerClientData[];
  size_on_disk?: string;
  rt_recent_activity_time?: number;
  rt_last_time_played?: number;
  rt_purchased_time?: number;
  rt_original_release_date?: number;
  /** `store_category` is a getter over this, so this is what to write. */
  m_setStoreCategories?: Set<number>;
}

/**
 * Rewrite one overview to match Epic. `local_per_client_data` drives the app page,
 * `per_client_data` the grid tile, and `size_on_disk` the filters and collections.
 */
function apply(overview: SteamAppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game) return;

  const app = overview as unknown as MutableOverview;

  // Shortcuts have no purchase date, so every Epic game would land in "No recorded
  // activity". As for Steam's own apps, it's the later of last play and the grant.
  if (game.purchased_at) {
    app.rt_purchased_time = game.purchased_at;
    app.rt_recent_activity_time = Math.max(
      app.rt_last_time_played ?? 0,
      app.rt_recent_activity_time ?? 0,
      game.purchased_at,
    );
  }

  // What the game info panel shows as the release date, and its feature list and
  // the library's feature filters read as categories.
  const released = info.get(game.app_name)?.released_at;
  if (released) app.rt_original_release_date = released;

  const categories = categoriesFor(game.app_name);
  if (categories.length > 0) {
    app.m_setStoreCategories = new Set([...(app.m_setStoreCategories ?? []), ...categories]);
  }

  const job = jobs.get(game.app_name);
  const status =
    job && JOB_STATUSES[job.kind]?.[["running", "paused", "queued"].indexOf(job.state)];
  // Only a download isn't on disk yet: an update keeps the old build launchable, and
  // a delete's files are there until it finishes.
  const installed = job && status !== undefined ? job.kind !== "install" : game.installed;
  const percent =
    job && status !== undefined && job.kind !== "uninstall" ? job.progress?.percent : 0;

  // Not trusted to be an array: spreading anything else throws on the render path.
  const perClient = Array.isArray(app.per_client_data) ? app.per_client_data : [];

  for (const data of [app.local_per_client_data, ...perClient]) {
    if (!data) continue;

    data.installed = installed;
    data.status_percentage = percent ?? 0;

    if (status !== undefined) data.display_status = status;
    else if (!(game.installed && RUNNING_STATUSES.has(data.display_status ?? 0))) {
      // UpdateRequired turns Play into Update, the only place needs_update shows.
      if (!game.installed) data.display_status = EDisplayStatus.ReadyToInstall;
      else if (game.needs_update) data.display_status = EDisplayStatus.UpdateRequired;
      else data.display_status = EDisplayStatus.ReadyToLaunch;
    }
  }

  // The Installed collection tests this, so a half-downloaded game stays out of it.
  app.size_on_disk = installed ? `${game.install_size ?? 0}` : undefined;
}

export function register() {
  return beforePatch(collectionStore, "OnAppOverviewChange", ([apps]: [SteamAppOverview[]]) => {
    for (const app of apps) apply(app);
  }).unpatch;
}

/**
 * Correct the overviews Steam already holds, by appid since `allApps` holds
 * thousands. Not through OnAppOverviewChange, which throws "t is not iterable" on
 * the store's own objects.
 */
export function refreshAll() {
  const apps = library
    .appIdsWithGames()
    .map((appId) => appStore.GetAppOverviewByAppID(appId))
    .filter((app) => app !== undefined);
  if (apps.length === 0) return;

  for (const app of apps) apply(app);
  forceFakeLocationChange();
}
