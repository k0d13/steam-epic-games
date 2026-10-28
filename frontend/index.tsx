import { definePlugin, IconsModule } from "millennium";
import { PluginPanel } from "./components/panel/plugin-panel";
import * as downloads from "./patches/downloads/downloads";
import * as installWizard from "./patches/downloads/install-wizard";
import * as installs from "./patches/downloads/installs";
import * as downloadOverview from "./patches/downloads/overview";
import * as storage from "./patches/downloads/storage";
import * as achievementPatches from "./patches/game-page/achievements";
import * as activity from "./patches/game-page/activity";
import * as cloudSaves from "./patches/game-page/cloud";
import * as dlc from "./patches/game-page/dlc";
import * as gameInfo from "./patches/game-page/game-info";
import * as appDetails from "./patches/library/app-details";
import * as overviews from "./patches/library/overviews";
import * as general from "./patches/properties/general";
import * as freeGames from "./services/epic/free-games";
import * as orders from "./services/epic/orders";
import * as epicSession from "./services/epic/session";
import * as verification from "./services/epic/verification";
import * as artwork from "./services/steam/artwork";
import { notify } from "./services/steam/notifications";
import { onGameStopped, onSessionEnded } from "./services/steam/playtime";
import * as shortcuts from "./services/steam/shortcuts";
import { autoSync } from "./services/sync/sync";
import * as account from "./state/account";
import * as appIds from "./state/app-ids";
import * as achievements from "./state/game/achievements";
import * as cloud from "./state/game/cloud";
import * as info from "./state/game/info";
import * as playtime from "./state/game/playtime";
import * as sizes from "./state/game/sizes";
import * as jobs from "./state/jobs";
import * as library from "./state/library";
import * as preferences from "./state/preferences";

// Steam's own code calls these through the patches in backend/patches.lua
/** @ffi */
export { ManageSubmenu } from "./patches/library/manage-menu";
/** @ffi */
export { EpicLinkClick, IsEpicURL } from "./services/epic/store";
/** @ffi */
export { SupernavMenu } from "./patches/store/menu";
/** @ffi */
export { PropertiesPages } from "./patches/properties/installed-files";
/** @ffi */
export { LibraryBadge } from "./patches/library/badge";
/** @ffi */
export { AchievementStore } from "./patches/game-page/achievements";
/** @ffi */
export { IsEpicApp } from "./patches/game-page/activity";
/** @ffi */
export { SteamURL } from "./patches/game-page/dlc";
/** @ffi */
export { AppDetailsChanged } from "./patches/library/app-details";
/** @ffi */
export {
  HasGameInfo,
  IsEpicGame,
  ShortcutLinks,
  ShortcutSections,
} from "./patches/game-page/game-info";

// IconsModule varies between Steam builds, and a missing icon mustn't break the plugin
const PluginIcon = IconsModule?.Download ?? IconsModule?.Settings ?? (() => null);

const PATCHES = [
  ["overviews", overviews.register],
  ["app details", appDetails.register],
  ["game info", gameInfo.register],
  ["installs", installs.register],
  ["install wizard", installWizard.register],
  ["achievements", achievementPatches.register],
  ["activity", activity.register],
  ["cloud saves", cloudSaves.register],
  ["dlc", dlc.register],
  ["general", general.register],
  ["storage", storage.register],
  ["downloads", downloads.register],
] as const;

// Guarded so a patch that no longer applies only costs its own feature
function registerPatches() {
  const unpatches: (() => void)[] = [];

  for (const [name, register] of PATCHES) {
    try {
      unpatches.push(register());
    } catch (e) {
      console.error(`Could not register the ${name} patch`, e);
    }
  }

  return () => unpatches.forEach((unpatch) => unpatch());
}

// Steam keeps its overviews, so changes must ask for a repaint; coalesced, since a
// poll often lands a jobs and a library change on the same tick
let repaintQueued = false;

function repaint() {
  if (repaintQueued) return;
  repaintQueued = true;

  setTimeout(() => {
    repaintQueued = false;
    downloadOverview.sync();
    downloads.sync();
    overviews.refreshAll();
    appDetails.refreshAll();
  }, 16);
}

function connect() {
  return [
    // Signed out the backend's library is empty, so every account change fetches it again
    account.watch((status) => void library.load(status.authenticated).then(autoSync)),
    epicSession.start(),
    orders.watch(),
    freeGames.watch(),
    jobs.onEnded((job) => {
      if (job.kind === "verify") return verification.onVerified(job);
      if (job.state !== "done" || !jobs.isDownload(job)) return;
      const appId = appIds.getAppId(job.app_name);
      if (appId !== undefined) notify("download-completed", appId);
    }),

    // A new build can bring new art, achievements and size
    library.onUpdated((game) => {
      sizes.forget(game.app_name);
      achievements.forget(game.app_name);
      const appId = appIds.getAppId(game.app_name);
      if (appId !== undefined) void artwork.apply(appId, game);
    }),

    // Running installs repaint every second, as the progress bar reads off the overview
    library.subscribe(repaint),
    library.subscribe(storage.refresh),
    library.subscribe(() => void shortcuts.align()),
    jobs.subscribe(repaint),
    achievements.subscribe(repaint),
    info.subscribe(repaint),
    playtime.subscribe(repaint),
    preferences.subscribe(repaint),

    // A session ending leaves the achievement cache short
    onGameStopped((appId) => {
      const game = library.getByAppId(appId);
      if (game) void achievements.refresh(game.app_name);
    }),
    // Only for sessions we saw start, as a game already running may not have had its saves
    // synced first. Play time is kept by app name, so it survives the shortcut being remade
    onSessionEnded((appId, startedAt, endedAt) => {
      const game = library.getByAppId(appId);
      if (!game) return;
      void playtime.record(game.app_name, startedAt, endedAt);
      void cloudSaves.syncAfterExit(appId);
    }),
  ];
}

// Not awaited by the plugin, as the first backend call can be a legendary download
// that would hold up the whole client, themes included
async function load() {
  // Cache only, so every shortcut reads as installed until this resolves
  await library.load();

  // Installs are detached and outlive a Steam restart, so resume polling them
  await jobs.refresh();

  // What we and Epic last had, then Epic's latest, which costs a round trip
  void playtime.load().then(() => playtime.load(true));

  void cloud.load();

  // Last, as it follows up with a round trip per recently played game
  void achievements.loadSummaries();

  // A cached library never shows updates, as legendary compares against the catalog it fetched
  void library.refreshOnStartup().then(autoSync);
}

export default definePlugin(async () => {
  // Before the library loads, so overviews built meanwhile are patched
  const unpatch = registerPatches();
  const unsubscribes = connect();

  window.addEventListener("beforeunload", () => {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    // Our appid would survive a reload in Steam's overview as a dead download
    downloadOverview.release();
    unpatch();
  });

  void load();
  console.info("Plugin loaded");

  return {
    title: "Epic Games",
    icon: <PluginIcon />,
    content: <PluginPanel />,
  };
});
