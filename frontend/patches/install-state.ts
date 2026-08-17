import { beforePatch, EDisplayStatus } from "@steambrew/client";
import { forceFakeLocationChange, NON_STEAM_APP_APPID_MASK, Steam } from "steambrew-utils";
import { logger } from "../index";
import * as library from "../state/library";

// This is the whole trick.
//
// A non-Steam shortcut is installed by definition - it points at a file on your
// disk, so Steam has no concept of it being absent. Left alone, 200 Epic
// freebies added as shortcuts all claim to be installed, show a Play button for
// a game that isn't there, poison every "Installed" filter, and land in
// automatic collections nobody asked for.
//
// CollectionStore.OnAppOverviewChange is the funnel every overview passes
// through before the grid, the filters and the sort read it. Correcting install
// state there gets uninstalled Epic games rendered and filtered natively.

let verified = false;

/**
 * The overview fields we write. None are in @steambrew/client's typings, being
 * plain properties on a store object, so this describes only what we touch.
 */
interface PerClientData {
  installed?: boolean;
  display_status?: number;
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
 * "Installed" filter and the automatic collections test.
 */
function applyInstallState(overview: Steam.AppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game) return;

  const app = overview as unknown as MutableOverview;

  for (const data of [app.local_per_client_data, ...(app.per_client_data ?? [])]) {
    if (!data) continue;
    data.installed = game.installed;
    data.display_status = game.installed
      ? EDisplayStatus.ReadyToLaunch
      : EDisplayStatus.ReadyToInstall;
  }

  // The automatic "Installed" collection tests size_on_disk rather than the
  // per-client flags, so leaving this set makes an uninstalled game show up
  // there even once everything above is correct.
  app.size_on_disk = game.installed ? `${game.installSize ?? 0}` : undefined;

  if (!verified) {
    verified = true;
    logger.debug("Install state patch applied", {
      appId: app.appid,
      appName: game.appName,
      wanted: game.installed,
      // If these come back different from `wanted`, the properties are
      // read-only on this Steam build and none of this is having any effect.
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
        // Every real Steam game comes through here too, and the mask is a far
        // cheaper test than a map lookup.
        if (app.appid < NON_STEAM_APP_APPID_MASK) continue;
        applyInstallState(app);
      }
    },
  );

  logger.debug("Registered the install state patch");
  return patch.unpatch;
}

/**
 * Correct the overviews Steam has already built, and get the UI to redraw them.
 * Steam builds them long before the library has loaded, so without this the grid
 * keeps whatever it drew first.
 *
 * Don't be tempted to hand the apps back to OnAppOverviewChange: that's Steam's
 * *inbound* path for freshly deserialized overviews, and calling it with the
 * store's own objects throws "t is not iterable" out of UpdateApps. Mutating
 * directly and nudging the router touches nothing inside Steam's stores.
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
