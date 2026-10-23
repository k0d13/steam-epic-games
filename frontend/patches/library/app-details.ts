import type { AppDetails } from "millennium";
import * as cloud from "../../state/game/cloud";
import * as info from "../../state/game/info";
import * as playtime from "../../state/game/playtime";
import * as sizes from "../../state/game/sizes";
import * as jobs from "../../state/jobs";
import * as library from "../../state/library";
import * as preferences from "../../state/preferences";
import { getAchievements } from "../game-page/achievements";
import { applyCloud, checkCloud } from "../game-page/cloud";
import { applyDlc } from "../game-page/dlc";

// "Space Required" reads `bHasAnyLocalContent` and `lDiskSpaceRequiredBytes`, which shortcuts
// get wrong; backend/patches.lua has the store's AppDetailsChanged, a non-writable mobx
// action, call `AppDetailsChanged` first

// An install in progress counts as installed, so the play bar doesn't shift under the
// cursor as progress appears
function apply(details: AppDetails) {
  const game = library.getByAppId(details.unAppID);
  if (!game) return;

  // Epic keeps achievements per account, so uninstalled games show them too; left
  // alone while waiting, so the section doesn't flicker
  const achievements = getAchievements(game.app_name);
  if (achievements) details.achievements = achievements;

  // The play bar reads these, not the overview; the larger is kept, as in the overviews
  const played = playtime.get(game.app_name);
  if (played) {
    details.nPlaytimeForever = Math.max(
      details.nPlaytimeForever ?? 0,
      Math.floor(played.seconds / 60),
    );
    details.rtLastTimePlayed = Math.max(details.rtLastTimePlayed ?? 0, played.last_played ?? 0);
  }

  applyCloud(details, game);
  applyDlc(details, game);

  if (game.installed) return;

  // Any state, as a finished install is on disk a poll before the library knows
  details.bHasAnyLocalContent = jobs.get(game.app_name)?.kind === "install";
  if (details.bHasAnyLocalContent) return;

  const size = sizes.get(game.app_name);
  if (size) details.lDiskSpaceRequiredBytes = size.disk;
  // Fetches the manifest from Epic, so it's drawn on a later pass
  else sizes.ensure(game.app_name);
}

// Only the store's registrations come through here, so a scan of every shortcut that
// registers with SteamClient itself doesn't start a size and achievements fetch, each a
// legendary run, for hundreds of games
export function AppDetailsChanged(details: AppDetails) {
  checkCloud(details.unAppID);
  apply(details);
}

export function register() {
  // A size arriving is asynchronous and has no other way back into the UI, nor has a
  // sync moving on
  const unsubscribes = [sizes.subscribe(refreshAll), cloud.subscribe(refreshAll)];

  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}

// What we last sent for an app, so an unchanged pass costs no re-render
const applied = new Map<number, string>();

// Corrects the details Steam already holds through AppDetailsChanged, sending a copy
// or observers see the same reference and don't re-render
export function refreshAll() {
  const store = globalThis.appDetailsStore;
  if (!store) return;

  for (const { details } of store.m_mapAppData.values()) {
    const game = details && library.getByAppId(details.unAppID);
    if (!details || !game) continue;

    const updated = { ...details };
    apply(updated);

    // Only when changed since we last sent it, as this runs on every jobs poll
    const signature = [
      updated.bHasAnyLocalContent,
      updated.lDiskSpaceRequiredBytes,
      updated.achievements?.nAchieved,
      updated.achievements?.nTotal,
      updated.nPlaytimeForever,
      updated.rtLastTimePlayed,
      updated.bCloudEnabledForApp,
      updated.bCloudEnabledForAccount,
      updated.eCloudStatus,
      updated.vecDLC.map((dlc) => `${dlc.strState}${dlc.bEnabled}`).join(),
      // The info panel and its button appear with these, and read nothing from the details
      preferences.get().gameInfo,
      info.get(game.app_name)?.fetched_at,
    ].join("|");
    if (applied.get(details.unAppID) === signature) continue;

    applied.set(details.unAppID, signature);
    store.AppDetailsChanged(updated);
  }
}
