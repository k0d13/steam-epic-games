import { callOriginal, replacePatch } from "@steambrew/client";
import { NON_STEAM_APP_APPID_MASK } from "steambrew-utils";
import { logger } from "../index";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// Steam's Install, Pause and Resume buttons all end up in one of three
// SteamClient functions, and they're plain properties on a plain object. So
// rather than touching the buttons, we take over the three calls behind them
// and leave Steam to draw whatever install-state.ts tells it to.
//
// Every one of these falls through to Steam's own implementation for anything
// that isn't ours - these are global functions, and real Steam downloads go
// through them while an Epic game is installing.

/** Which of our games an appid is, if it's one of ours at all. */
function epicAppName(appId: number): string | undefined {
  if (appId < NON_STEAM_APP_APPID_MASK) return undefined;
  return library.getByAppId(appId)?.appName;
}

/**
 * The functions we patch. None are in @steambrew/client's typings - they're
 * properties on the native bridge object - so this describes only what we call.
 */
interface Installs {
  OpenInstallWizard(appIds: number[]): void;
  OpenUninstallWizard(appIds: number[], bConfirm: boolean): void;
}

interface Downloads {
  ResumeAppUpdate(appId: number, clientId?: string): void;
  EnableAllDownloads(enabled: boolean, clientId?: string): void;
}

interface Bridge {
  Installs: Installs;
  Downloads: Downloads;
}

export function register() {
  const bridge = SteamClient as unknown as Bridge;
  const patches = [
    // Steam's own install wizard is driven by the native client and only knows
    // real appids, so there's nothing to reuse: an Epic appid gets started
    // straight away. Until the install dialog exists this takes legendary's
    // default install location, which is what `legendary install` alone uses.
    replacePatch(bridge.Installs, "OpenInstallWizard", ([appIds]: [number[]]) => {
      const ours = (appIds ?? []).map(epicAppName).filter((name) => name !== undefined);
      if (ours.length === 0) return callOriginal;

      // A mixed selection is possible from a multi-select in the library, and
      // Steam still has to handle its own half of it.
      const theirs = (appIds ?? []).filter((appId) => epicAppName(appId) === undefined);
      if (theirs.length > 0) bridge.Installs.OpenInstallWizard(theirs);

      for (const appName of ours) void jobs.install(appName);
      return undefined;
    }),

    // What Steam's own uninstall dialog calls when you confirm it. Patching
    // here rather than at the menu item means the dialog is Steam's, wording
    // and layout and all, and anything else that routes through it works too.
    replacePatch(
      bridge.Installs,
      "OpenUninstallWizard",
      ([appIds, confirmed]: [number[], boolean]) => {
        const ours = (appIds ?? []).map(epicAppName).filter((name) => name !== undefined);
        if (ours.length === 0) return callOriginal;

        const theirs = (appIds ?? []).filter((appId) => epicAppName(appId) === undefined);
        if (theirs.length > 0) bridge.Installs.OpenUninstallWizard(theirs, confirmed);

        for (const appName of ours) void jobs.uninstall(appName);
        return undefined;
      },
    ),

    // Resume, and the Download button on an update. legendary has no resume of
    // its own: `install` against a partial download continues it.
    replacePatch(bridge.Downloads, "ResumeAppUpdate", ([appId]: [number, string?]) => {
      const appName = epicAppName(appId);
      if (!appName) return callOriginal;

      void jobs.install(appName);
      return undefined;
    }),

    // This is global - it's "pause all downloads", and carries no appid even
    // when it's one tile's Pause button that called it. So ours are paused
    // together and Steam's are left to Steam, which is what the button says it
    // does anyway.
    replacePatch(bridge.Downloads, "EnableAllDownloads", ([enabled]: [boolean, string?]) => {
      if (enabled) {
        for (const job of jobs.paused()) void jobs.install(job.appName);
      } else {
        void jobs.pauseAll();
      }

      return callOriginal;
    }),
  ];

  logger.debug("Registered the install patches");
  return () => {
    for (const patch of patches) patch.unpatch();
  };
}
