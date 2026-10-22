import { beforePatch, EDisplayStatus, type SteamAppOverview } from "millennium";
import { forceFakeLocationChange } from "../../services/steam/popups";
import * as playtime from "../../state/game/playtime";
import * as jobs from "../../state/jobs";
import * as library from "../../state/library";
import { categoriesFor, releasedAt, storeTagsFor } from "../game-page/game-info";

// Steam's overviews draw the library: tiles, filters, sort and the app page. Every
// one passes through OnAppOverviewChange first, so ours are corrected there

// Steam's running states, which ReadyToLaunch would turn back into a Play button
const RUNNING_STATUSES = new Set<number>([
  EDisplayStatus.Launching,
  EDisplayStatus.Running,
  EDisplayStatus.Terminating,
]);

// What a running, paused and queued job of each kind shows
const JOB_STATUSES: Record<string, number[]> = {
  // Downloading, not Installing, since only it gets a percentage bar
  install: [
    EDisplayStatus.Downloading,
    EDisplayStatus.DownloadPaused,
    EDisplayStatus.DownloadQueued,
  ],
  update: [EDisplayStatus.Updating, EDisplayStatus.UpdatePaused, EDisplayStatus.UpdateQueued],
  // Like an update, as the game stays launchable while its files are checked and fixed
  repair: [EDisplayStatus.Updating, EDisplayStatus.UpdatePaused, EDisplayStatus.UpdateQueued],
  verify: [EDisplayStatus.Validating, EDisplayStatus.Validating, EDisplayStatus.Validating],
  uninstall: [
    EDisplayStatus.Uninstalling,
    EDisplayStatus.Uninstalling,
    EDisplayStatus.Uninstalling,
  ],
};
const JOB_STATES = ["running", "paused", "queued"];

// The fields we write, none of which are in @steambrew/client's typings
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
  minutes_playtime_forever?: number;
  rt_purchased_time?: number;
  rt_original_release_date?: number;
  // `store_category` and `store_tag` are getters over these, so these are what to write
  m_setStoreCategories?: Set<number>;
  m_setStoreTags?: Set<number>;
}

// What we last put in an overview's release date, categories and tags, taken back out
// before the next pass so turning the info off or a tag going away leaves nothing behind
interface Added {
  released?: number;
  categories: number[];
  tags: number[];
}

const added = new Map<number, Added>();

function applyInfo(app: MutableOverview, appId: number, appName: string) {
  const previous = added.get(appId);
  const next: Added = {
    released: releasedAt(appName),
    categories: categoriesFor(appName),
    tags: storeTagsFor(appName),
  };
  added.set(appId, next);

  // The release date the info panel shows
  if (next.released) app.rt_original_release_date = next.released;
  else if (previous?.released && app.rt_original_release_date === previous.released) {
    app.rt_original_release_date = 0;
  }

  // The categories the info panel's feature list and the library's feature filters read,
  // and the tags its genre filters read
  if (previous || next.categories.length > 0) {
    const categories = new Set(app.m_setStoreCategories ?? []);
    for (const id of previous?.categories ?? []) categories.delete(id);
    for (const id of next.categories) categories.add(id);
    app.m_setStoreCategories = categories;
  }
  if (previous || next.tags.length > 0) {
    const tags = new Set(app.m_setStoreTags ?? []);
    for (const id of previous?.tags ?? []) tags.delete(id);
    for (const id of next.tags) tags.add(id);
    app.m_setStoreTags = tags;
  }
}

function idleStatus(game: EpicGame, current: number | undefined) {
  if (game.installed && RUNNING_STATUSES.has(current ?? 0)) return current;
  if (!game.installed) return EDisplayStatus.ReadyToInstall;
  // UpdateRequired turns Play into Update, the only place needs_update shows
  return game.needs_update ? EDisplayStatus.UpdateRequired : EDisplayStatus.ReadyToLaunch;
}

// `local_per_client_data` drives the app page, `per_client_data` the grid tile and
// `size_on_disk` the filters and collections
function apply(overview: SteamAppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game) return;

  const app = overview as unknown as MutableOverview;

  // Steam counts from when the shortcut was made, so what we and Epic kept can be more;
  // the larger is kept, as Steam's own grows with each session too
  const played = playtime.get(game.app_name);
  if (played) {
    app.minutes_playtime_forever = Math.max(
      app.minutes_playtime_forever ?? 0,
      Math.floor(played.seconds / 60),
    );
    app.rt_last_time_played = Math.max(app.rt_last_time_played ?? 0, played.last_played ?? 0);
  }

  // Shortcuts have no purchase date, so every Epic game would land in "No recorded
  // activity"; as for Steam's own apps, it's the later of last play and the grant
  if (game.purchased_at) {
    app.rt_purchased_time = game.purchased_at;
    app.rt_recent_activity_time = Math.max(
      app.rt_last_time_played ?? 0,
      app.rt_recent_activity_time ?? 0,
      game.purchased_at,
    );
  }

  applyInfo(app, overview.appid, game.app_name);

  const job = jobs.get(game.app_name);
  const status = job && JOB_STATUSES[job.kind]?.[JOB_STATES.indexOf(job.state)];
  // Only a download isn't on disk yet: an update keeps the old build launchable, and a
  // delete's files are there until it finishes
  const installed = job && status !== undefined ? job.kind !== "install" : game.installed;
  const percent =
    job && status !== undefined && job.kind !== "uninstall" ? job.progress?.percent : 0;

  // Not trusted to be an array, as spreading anything else throws on the render path
  const perClient = Array.isArray(app.per_client_data) ? app.per_client_data : [];

  for (const data of [app.local_per_client_data, ...perClient]) {
    if (!data) continue;

    data.installed = installed;
    data.status_percentage = percent ?? 0;
    data.display_status = status ?? idleStatus(game, data.display_status);
  }

  // The Installed collection tests this, so a half-downloaded game stays out of it
  app.size_on_disk = installed ? `${game.install_size ?? 0}` : undefined;
}

export function register() {
  return beforePatch(collectionStore, "OnAppOverviewChange", ([apps]: [SteamAppOverview[]]) => {
    for (const app of apps) apply(app);
  }).unpatch;
}

// Corrects the overviews Steam already holds, by appid since `allApps` holds thousands;
// not through OnAppOverviewChange, which throws "t is not iterable" on the store's own objects
export function refreshAll() {
  const apps = library
    .appIdsWithGames()
    .map((appId) => appStore.GetAppOverviewByAppID(appId))
    .filter((app) => app !== undefined);
  if (apps.length === 0) return;

  for (const app of apps) apply(app);
  forceFakeLocationChange();
}
