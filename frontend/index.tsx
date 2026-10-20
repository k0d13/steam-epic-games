import { definePlugin, IconsModule } from "millennium";
import { PluginPanel } from "./components/panel/plugin-panel";
import * as downloads from "./patches/downloads/downloads";
import * as installWizard from "./patches/downloads/install-wizard";
import * as installs from "./patches/downloads/installs";
import * as downloadOverview from "./patches/downloads/overview";
import * as storage from "./patches/downloads/storage";
import * as gameInfo from "./patches/game-page/game-info";
import * as achievementProgress from "./patches/library/achievement-progress";
import * as appDetails from "./patches/library/app-details";
import * as overviews from "./patches/library/overviews";
import * as orders from "./services/epic/orders";
import * as epicSession from "./services/epic/session";
import * as artwork from "./services/steam/artwork";
import { notifyDownloadCompleted } from "./services/steam/notifications";
import { onGameStopped } from "./services/steam/playtime";
import * as shortcuts from "./services/steam/shortcuts";
import { autoSync } from "./services/sync/sync";
import * as account from "./state/account";
import * as achievements from "./state/achievements";
import * as appIds from "./state/app-ids";
import * as info from "./state/info";
import * as jobs from "./state/jobs";
import * as library from "./state/library";
import * as preferences from "./state/preferences";
import * as sizes from "./state/sizes";

// Millennium puts these on our PLUGIN_LIST slot, where backend/patches.lua has Steam's
// own code call them
/** @ffi */
export { ManageSubmenu } from "./patches/library/manage-menu";
/** @ffi */
export { IsEpicURL } from "./services/epic/store";
/** @ffi */
export { SupernavMenu } from "./patches/store/menu";
/** @ffi */
export { LibraryBadge } from "./patches/library/badge";
/** @ffi */
export { AchievementStore } from "./patches/game-page/achievements";
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
  ["achievement progress", achievementProgress.register],
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
    // The store decides who's signed in: signed out, the backend's library is empty,
    // and signed in as someone, it's theirs to fetch
    account.watch((status) => void library.load(status.authenticated).then(autoSync)),
    // Signs legendary in and out with the store in Steam's browser
    epicSession.start(),
    // A game bought or claimed there lands in Steam without a manual refresh
    orders.watch(),
    // Steam notifies a download finishing, and ours do too
    jobs.onEnded((job) => {
      if (job.state !== "done" || !jobs.isDownload(job)) return;
      const appId = appIds.getAppId(job.app_name);
      if (appId !== undefined) notifyDownloadCompleted(appId);
    }),

    // A new build can bring new art, achievements and size; achievements wait for
    // something to read them, since each is a legendary run
    library.onUpdated((game) => {
      sizes.forget(game.app_name);
      achievements.forget(game.app_name);
      const appId = appIds.getAppId(game.app_name);
      if (appId !== undefined) void artwork.apply(appId, game);
    }),

    // Running installs repaint every second, as the progress bar reads off the overview
    library.subscribe(repaint),
    // Not on the repaint, as the storage page only changes when what's installed does
    library.subscribe(storage.refresh),
    // A shortcut's working directory follows its game being installed or removed
    library.subscribe(() => void shortcuts.align()),
    jobs.subscribe(repaint),
    // Achievements and info land a round trip to Epic after the page asking for them drew
    achievements.subscribe(repaint),
    info.subscribe(repaint),
    // Turning game info on or off changes what every overview and page shows
    preferences.subscribe(repaint),

    // A session ending is when an achievement cache is certain to be short
    onGameStopped((appId) => {
      const game = library.getByAppId(appId);
      if (game) void achievements.refresh(game.app_name);
    }),
  ];
}

// Not awaited by the plugin: the first backend call can be a legendary download, and
// awaiting it held up the whole client, themes included
async function load() {
  // Cache only, so every shortcut reads as installed until this resolves
  await library.load();

  // Installs are detached and outlive a Steam restart, so resume polling them
  await jobs.refresh();

  // Lets the library home sort by completion early; last, since it follows up with a
  // round trip per recently played game
  void achievements.loadSummaries();

  // A cached library never shows updates, as legendary compares against the catalog it
  // fetched; costs a round trip, so nothing waits on it
  void library.load(true, true).then(autoSync);
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
