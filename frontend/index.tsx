import { definePlugin, IconsModule } from "millennium";
import { PluginPanel, UnsupportedPanel } from "./components/plugin-panel";
import * as achievementProgress from "./patches/achievement-progress";
import * as appDetails from "./patches/app-details";
import * as downloadOverview from "./patches/download-overview";
import * as downloads from "./patches/downloads";
import * as installWizard from "./patches/install-wizard";
import * as installs from "./patches/installs";
import * as overviews from "./patches/overviews";
import * as storage from "./patches/storage";
import * as epicSession from "./services/epic-session";
import { notifyDownloadCompleted } from "./services/notifications";
import * as orders from "./services/orders";
import { onGameStopped } from "./services/playtime";
import * as shortcuts from "./services/shortcuts";
import * as steamLibrary from "./services/steam-library";
import * as account from "./state/account";
import * as achievements from "./state/achievements";
import * as appIds from "./state/app-ids";
import * as jobs from "./state/jobs";
import * as library from "./state/library";

// Millennium puts these on our PLUGIN_LIST slot, where backend/patches.lua has
// Steam's own code call them.
/** @ffi */
export { ManageSubmenu } from "./patches/manage-menu";
/** @ffi */
export { IsEpicURL, SupernavMenu } from "./patches/store-menu";
/** @ffi */
export { LibraryBadge } from "./patches/library-badge";
/** @ffi */
export { AchievementStore, ShortcutSections } from "./patches/achievements";

// IconsModule varies between Steam builds; a missing icon mustn't break the plugin.
const PluginIcon = IconsModule?.Download ?? IconsModule?.Settings ?? (() => null);

export default definePlugin(async () => {
  if (!navigator.userAgent.includes("Windows")) {
    console.warn("Not on Windows, so nothing was patched");
    return { title: "Epic Games", icon: <PluginIcon />, content: <UnsupportedPanel /> };
  }

  // Before the library loads, so overviews built meanwhile are patched. Guarded so
  // a patch that no longer applies only costs its own feature.
  const unpatches: (() => void)[] = [];
  for (const [name, patch] of [
    ["overviews", overviews.register],
    ["app details", appDetails.register],
    ["installs", installs.register],
    ["install wizard", installWizard.register],
    ["achievement progress", achievementProgress.register],
    ["storage", storage.register],
    ["downloads", downloads.register],
  ] as const) {
    try {
      unpatches.push(patch());
    } catch (e) {
      console.error(`Could not register the ${name} patch`, e);
    }
  }

  // Steam keeps its overviews, so changes must ask for a repaint. Coalesced, since
  // a poll often lands a jobs and a library change on the same tick.
  let repaintQueued = false;
  const repaint = () => {
    if (repaintQueued) return;
    repaintQueued = true;

    setTimeout(() => {
      repaintQueued = false;
      downloadOverview.sync();
      downloads.sync();
      overviews.refreshAll();
      appDetails.refreshAll();
    }, 16);
  };

  const unsubscribes = [
    // The store decides who's signed in. Signed out, the backend's library is
    // empty; signed in as someone, it's theirs to fetch.
    account.watch((status) => void library.load(status.authenticated).then(steamLibrary.autoSync)),
    // Signs legendary in and out with the store in Steam's browser.
    epicSession.start(),
    // A game bought or claimed there lands in Steam without a manual refresh.
    orders.watch(),
    // Steam notifies a download finishing; ours do too.
    jobs.onEnded((job) => {
      if (job.state !== "done" || !jobs.isDownload(job)) return;
      const appId = appIds.getAppId(job.app_name);
      if (appId !== undefined) notifyDownloadCompleted(appId);
    }),

    // Running installs repaint every second: the progress bar reads off the overview.
    library.subscribe(repaint),
    // Not on the repaint: the storage page only changes when what's installed does.
    library.subscribe(storage.refresh),
    // A shortcut's working directory follows its game being installed or removed.
    library.subscribe(() => void shortcuts.alignShortcuts()),
    jobs.subscribe(repaint),
    // Achievements land a round trip to Epic after the page asking for them drew.
    achievements.subscribe(repaint),

    // A session ending is when an achievement cache is certain to be short.
    onGameStopped((appId) => {
      const game = library.getByAppId(appId);
      if (game) void achievements.refresh(game.app_name);
    }),
  ];

  window.addEventListener("beforeunload", () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    // Our appid would survive a reload in Steam's overview as a dead download.
    downloadOverview.release();
    for (const unpatch of unpatches) unpatch();
  });

  // Not awaited: the first backend call can be a legendary download, and awaiting
  // it held up the whole client, themes included.
  void (async () => {
    // Cache only: every shortcut reads as installed until this resolves.
    await library.load();

    // Installs are detached and outlive a Steam restart, so resume polling them.
    await jobs.refresh();

    // Lets the library home sort by completion early. Last, since it follows up
    // with a round trip per recently played game.
    void achievements.loadSummaries();

    // A cached library never shows updates: legendary compares against the catalog
    // it fetched. Costs a round trip, so nothing waits on it.
    void library.load(true, true).then(steamLibrary.autoSync);
  })();

  console.info("Plugin loaded");

  return {
    title: "Epic Games",
    icon: <PluginIcon />,
    content: <PluginPanel />,
  };
});
