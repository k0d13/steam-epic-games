import { beforePatch, type SteamAppOverview } from "@steambrew/client";
import { logger } from "../index";
import { forceFakeLocationChange } from "../services/popups";
import { NON_STEAM_APP_APPID_MASK } from "../state/app-ids";
import * as library from "../state/library";

// A non-Steam shortcut has no purchase date, so every Epic game lands in the
// library's "No recorded activity" section, which Steam builds by bucketing
// `rt_recent_activity_time` by year and calling anything more than ten years old
// unrecorded. Steam's own apps get that field from the later of the last play
// and the purchase, so an Epic game gets it from the later of the last play and
// the date Epic granted the account the game.

interface MutableOverview {
  appid: number;
  rt_recent_activity_time?: number;
  rt_last_time_played?: number;
  rt_purchased_time?: number;
}

function applyActivity(overview: SteamAppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game?.purchasedAt) return;

  const app = overview as unknown as MutableOverview;

  app.rt_purchased_time = game.purchasedAt;
  app.rt_recent_activity_time = Math.max(
    app.rt_last_time_played ?? 0,
    app.rt_recent_activity_time ?? 0,
    game.purchasedAt,
  );
}

export function register() {
  const patch = beforePatch(
    collectionStore,
    "OnAppOverviewChange",
    ([apps]: [SteamAppOverview[]]) => {
      for (const app of apps) {
        if (app.appid < NON_STEAM_APP_APPID_MASK) continue;
        applyActivity(app);
      }
    },
  );

  logger.debug("Registered the activity patch");
  return patch.unpatch;
}

/** Correct the overviews Steam built before the library loaded. */
export function refreshAll() {
  const apps = appStore.allApps.filter(
    (app) => app.appid >= NON_STEAM_APP_APPID_MASK && library.getByAppId(app.appid) !== undefined,
  );

  if (apps.length === 0) return;

  for (const app of apps) applyActivity(app);

  forceFakeLocationChange();
  logger.debug("Refreshed the Epic activity dates", { count: apps.length });
}
