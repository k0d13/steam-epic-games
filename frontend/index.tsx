import { definePlugin, DialogButton, DialogControlsSection, Field, IconsModule } from "millennium";
import { useState, useSyncExternalStore } from "react";
import { LibraryPanel } from "./components/library-panel";
import * as achievementProgress from "./patches/achievement-progress";
import * as achievementsPatch from "./patches/achievements";
import * as activity from "./patches/activity";
import * as appDetails from "./patches/app-details";
import * as downloadOverview from "./patches/download-overview";
import * as downloads from "./patches/downloads";
import * as installState from "./patches/install-state";
import * as installWizard from "./patches/install-wizard";
import * as installs from "./patches/installs";
import * as libraryBadge from "./patches/library-badge";
import * as manageMenu from "./patches/manage-menu";
import * as storage from "./patches/storage";
import * as storeMenu from "./patches/store-menu";
import * as epicSession from "./services/epic-session";
import { onGameStopped } from "./services/playtime";
import * as shortcuts from "./services/shortcuts";
import * as account from "./state/account";
import * as achievements from "./state/achievements";
import * as jobs from "./state/jobs";
import * as library from "./state/library";

// IconsModule varies between Steam builds; a missing icon mustn't break the plugin.
const PluginIcon = IconsModule?.Download ?? IconsModule?.Settings ?? (() => null);

// Sign in and out happen on Epic's store in Steam's browser (see epic-session), so
// the panel only reports the account.
function Panel() {
  const status = useSyncExternalStore(account.subscribe, account.get);
  const [busy, setBusy] = useState(false);

  // Forcing a status re-runs the download, for a machine that was offline.
  const onRetry = async () => {
    setBusy(true);
    try {
      await backend.get_status(true);
    } catch (reason: unknown) {
      console.warn("get_status failed", reason);
    }
    setBusy(false);
  };

  let description: string;
  if (!status) description = "Checking for Legendary...";
  else if (!status.available)
    description = status.error ?? "Legendary could not be downloaded or run.";
  else if (status.authenticated) description = `Signed in as ${status.account}`;
  else
    description =
      "Not signed in. Open Store > Epic Games Store and sign in there, and this " +
      "picks up your account.";

  // One section: Steam drops the separator on a section's last field, so two
  // would leave the rows touching.
  return (
    <DialogControlsSection>
      <Field
        label="Epic account"
        description={description}
        childrenContainerWidth="min"
        bottomSeparator={status?.authenticated ? "standard" : "none"}
      >
        {status && !status.available && (
          <DialogButton disabled={busy} onClick={onRetry}>
            {busy ? "Downloading..." : "Retry"}
          </DialogButton>
        )}
      </Field>
      {status?.authenticated && <LibraryPanel />}
    </DialogControlsSection>
  );
}

export default definePlugin(async () => {
  // Before the library loads, so overviews built meanwhile are patched. Guarded so
  // a patch that no longer applies only costs its own feature.
  const unpatches: (() => void)[] = [];
  for (const [name, patch] of [
    ["install state", installState.register],
    ["app details", appDetails.register],
    ["installs", installs.register],
    ["install wizard", installWizard.register],
    ["manage menu", manageMenu.register],
    ["library badge", libraryBadge.register],
    ["activity", activity.register],
    ["achievements", achievementsPatch.register],
    ["achievement progress", achievementProgress.register],
    ["storage", storage.register],
    ["downloads", downloads.register],
    ["store menu", storeMenu.register],
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
      installState.refreshAll();
      activity.refreshAll();
      appDetails.refreshAll();
    }, 16);
  };

  const unsubscribes = [
    // The store decides who's signed in. Signed out, the backend's library is
    // empty; signed in as someone, it's theirs to fetch.
    account.watch((status) => void library.load(status.authenticated)),
    // Signs legendary in and out with the store in Steam's browser.
    epicSession.start(),

    // Running installs repaint every second: the progress bar reads off the overview.
    library.subscribe(repaint),
    // Not on the repaint: the storage page only changes when what's installed does.
    library.subscribe(storage.refresh),
    // A shortcut's working directory follows its game being installed or removed.
    library.subscribe(() => void shortcuts.alignStartDirs()),
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
    void library.load(true, true);
  })();

  console.info("Plugin loaded");

  return {
    title: "Epic Games",
    icon: <PluginIcon />,
    content: <Panel />,
  };
});
