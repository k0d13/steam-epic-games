import { definePlugin, DialogControlsSection, IconsModule } from "@steambrew/client";
import { useCallback, useState } from "react";
import { Logger } from "steambrew-utils/logger";
import { AuthPanel } from "./components/auth-panel";
import { LibraryPanel } from "./components/library-panel";
import * as appDetails from "./patches/app-details";
import * as downloadOverview from "./patches/download-overview";
import * as installState from "./patches/install-state";
import * as installWizard from "./patches/install-wizard";
import * as installs from "./patches/installs";
import * as manageMenu from "./patches/manage-menu";
import { type EpicStatus } from "./rpc";
import * as jobs from "./state/jobs";
import * as library from "./state/library";

export const logger = new Logger("Steam Epic Games");

// IconsModule is typed as `any` and its contents vary between Steam builds, so
// fall back rather than letting a missing icon take the whole plugin down.
const PluginIcon = IconsModule?.Download ?? IconsModule?.Settings ?? (() => null);

// The plugin's own panel, which is where setup lives. Reachable whether or not
// anything is signed in, unlike the app properties dialog.
function Panel() {
  const [authenticated, setAuthenticated] = useState(false);

  // Stable identity, or AuthPanel's status effect would re-run on every render.
  const onStatus = useCallback((status: EpicStatus) => {
    setAuthenticated(status.authenticated);
  }, []);

  // One section around both, so their fields are siblings: Steam suppresses the
  // separator on a section's last field, and two sections stacked leave the
  // account row and the library row touching with nothing between them.
  return (
    <DialogControlsSection>
      <AuthPanel onStatus={onStatus} />
      {authenticated && <LibraryPanel />}
    </DialogControlsSection>
  );
}

export default definePlugin(async () => {
  // Before the library loads, so overviews Steam builds meanwhile go through
  // the patch. Guarded so a patch that no longer applies costs its own feature
  // rather than the plugin.
  const unpatches: (() => void)[] = [];
  for (const [name, patch] of [
    ["install state", installState.register],
    ["app details", appDetails.register],
    ["installs", installs.register],
    ["install wizard", installWizard.register],
    ["manage menu", manageMenu.register],
  ] as const) {
    try {
      unpatches.push(patch());
    } catch (e) {
      logger.error(`Could not register the ${name} patch`, e);
    }
  }

  // Steam builds its overviews once and keeps them, so every change to the
  // library has to ask for a repaint.
  const repaint = () => {
    downloadOverview.sync();
    installState.refreshAll();
    appDetails.refreshAll();
  };

  // A running install repaints once a second, since its progress bar is read
  // off the overview.
  const unsubscribe = library.subscribe(repaint);
  const unsubscribeJobs = jobs.subscribe(repaint);

  window.addEventListener("beforeunload", () => {
    unsubscribe();
    unsubscribeJobs();
    // The overview is Steam's: our appid left in it survives a reload and
    // shows a download nothing is writing to.
    downloadOverview.release();
    for (const unpatch of unpatches) unpatch();
  });

  // Cache only: every shortcut claims to be installed until this resolves, so
  // it can't wait on Epic. The panel asks for the real thing once it's up.
  await library.load();

  // Installs are detached, so they outlive a Steam restart: pick up anything
  // still running and start polling it again.
  await jobs.refresh();

  logger.info("Plugin loaded");

  return {
    title: "Epic Games",
    icon: <PluginIcon />,
    content: <Panel />,
  };
});
