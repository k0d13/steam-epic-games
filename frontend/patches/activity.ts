import { beforePatch, type SteamAppOverview } from "millennium";
import { forceFakeLocationChange } from "../services/popups";
import * as library from "../state/library";

// Shortcuts have no purchase date, so every Epic game lands in "No recorded activity".
// As for Steam's own apps, activity is the later of last play and the Epic grant date.

interface MutableOverview {
  appid: number;
  rt_recent_activity_time?: number;
  rt_last_time_played?: number;
  rt_purchased_time?: number;
}

function applyActivity(overview: SteamAppOverview) {
  const game = library.getByAppId(overview.appid);
  if (!game?.purchased_at) return;

  const app = overview as unknown as MutableOverview;

  app.rt_purchased_time = game.purchased_at;
  app.rt_recent_activity_time = Math.max(
    app.rt_last_time_played ?? 0,
    app.rt_recent_activity_time ?? 0,
    game.purchased_at,
  );
}

export function register() {
  const patch = beforePatch(
    collectionStore,
    "OnAppOverviewChange",
    ([apps]: [SteamAppOverview[]]) => {
      for (const app of apps) applyActivity(app);
    },
  );

  console.debug("Registered the activity patch");
  return patch.unpatch;
}

/** Correct the overviews Steam built before the library loaded. */
export function refreshAll() {
  const apps = library.overviews();
  if (apps.length === 0) return;

  for (const app of apps) applyActivity(app);

  forceFakeLocationChange();
  console.debug("Refreshed the Epic activity dates", { count: apps.length });
}
