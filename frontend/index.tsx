import { definePlugin, DialogControlsSection, IconsModule } from "@steambrew/client";
import { useCallback, useState } from "react";
import { Logger } from "steambrew-utils/logger";
import { AuthPanel } from "./components/auth-panel";
import { LibraryPanel } from "./components/library-panel";
import * as appDetails from "./patches/app-details";
import * as installState from "./patches/install-state";
import { type EpicStatus } from "./rpc";
import * as library from "./state/library";

export const logger = new Logger("Steam Epic Games");

// IconsModule is typed as `any` and its contents vary between Steam builds, so
// fall back rather than letting a missing icon take the whole plugin down.
const PluginIcon = IconsModule?.Download ?? IconsModule?.Settings ?? (() => null);

// Millennium renders this as the plugin's own panel, which is where setup
// lives. It's reachable whether or not anything has been signed in yet -
// unlike the app properties dialog, which needs a game to open first.
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
  // Before the library loads, so overviews Steam builds meanwhile go through the
  // patch. Guarded because Steam's stores move between client builds, and a
  // patch that no longer applies should cost its own feature, not the plugin.
  const unpatches: (() => void)[] = [];
  for (const [name, patch] of [
    ["install state", installState.register],
    ["app details", appDetails.register],
  ] as const) {
    try {
      unpatches.push(patch());
    } catch (e) {
      logger.info(`Could not register the ${name} patch`, e);
    }
  }

  // Steam builds its overviews and its details once and keeps them, so every
  // change to the library has to ask for a repaint. It is the only thing that does.
  const unsubscribe = library.subscribe(() => {
    installState.refreshAll();
    appDetails.refreshAll();
  });

  window.addEventListener("beforeunload", () => {
    unsubscribe();
    for (const unpatch of unpatches) unpatch();
  });

  // Cache only: every shortcut in the grid claims to be installed until this
  // resolves, so it can't be a `legendary list` against Epic. The panel asks for
  // the real thing once it's on screen.
  await library.load();

  logger.info("Plugin loaded");

  return {
    title: "Epic Games",
    icon: <PluginIcon />,
    content: <Panel />,
  };
});
