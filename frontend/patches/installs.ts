import { callOriginal, replacePatch } from "@steambrew/client";
import { NON_STEAM_APP_APPID_MASK } from "steambrew-utils";
import { logger } from "../index";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import * as wizard from "./install-wizard";

// Steam's Install, Pause and Resume buttons all end up in one of a few
// SteamClient functions, so rather than touching the buttons we take over the
// calls behind them and leave Steam to draw whatever install-state.ts says.
//
// Every one falls through to Steam's own implementation for anything that isn't
// ours: these are global, and real Steam downloads go through them too.

/** One of our games by appid, if it's one of ours at all. */
function epicGame(appId: number) {
  if (appId < NON_STEAM_APP_APPID_MASK) return undefined;
  return library.getByAppId(appId);
}

/** Which of our games an appid is, if it's one of ours at all. */
function epicAppName(appId: number): string | undefined {
  return epicGame(appId)?.appName;
}

/** Split a selection into our games and Steam's - a multi-select can be both. */
function partition(appIds: number[] | undefined) {
  const ours: number[] = [];
  const theirs: number[] = [];

  for (const appId of appIds ?? []) {
    (epicGame(appId) ? ours : theirs).push(appId);
  }

  return { ours, theirs };
}

/** The functions we patch. None of them are in @steambrew/client's typings. */
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
    // The native client only raises its install wizard for real appids, so ours
    // is opened from the JS side - same dialog. install-wizard.ts owns it.
    replacePatch(bridge.Installs, "OpenInstallWizard", ([appIds]: [number[]]) => {
      const { ours, theirs } = partition(appIds);
      if (ours.length === 0) return callOriginal;

      if (theirs.length > 0) bridge.Installs.OpenInstallWizard(theirs);

      // One dialog and one store field, so a multi-select of Epic games can
      // only open it for the first. `ours` is non-empty by the check above.
      const [first] = ours as [number, ...number[]];
      const game = epicGame(first);
      if (game) void wizard.open(first, game.appName, game.folderName);

      return undefined;
    }),

    // What Steam's own uninstall dialog calls on confirm. Patching here rather
    // than at the menu item keeps the dialog Steam's.
    replacePatch(
      bridge.Installs,
      "OpenUninstallWizard",
      ([appIds, confirmed]: [number[], boolean]) => {
        const { ours, theirs } = partition(appIds);
        if (ours.length === 0) return callOriginal;

        if (theirs.length > 0) bridge.Installs.OpenUninstallWizard(theirs, confirmed);

        for (const appId of ours) {
          const appName = epicAppName(appId);
          if (appName) void jobs.uninstall(appName);
        }

        return undefined;
      },
    ),

    // Resume, and the Download button on an update. legendary has no resume:
    // `install` against a partial download continues it.
    replacePatch(bridge.Downloads, "ResumeAppUpdate", ([appId]: [number, string?]) => {
      const appName = epicAppName(appId);
      if (!appName) return callOriginal;

      void jobs.install(appName);
      return undefined;
    }),

    // "Pause all downloads", which carries no appid even when one tile's Pause
    // button called it. So ours pause together and Steam's are left to Steam.
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
