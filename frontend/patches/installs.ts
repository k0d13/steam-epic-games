import { callOriginal, replacePatch } from "millennium";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import * as downloads from "./downloads";
import * as wizard from "./install-wizard";

// Steam's Install, Pause and Resume buttons all end up in one of a few
// SteamClient functions, so rather than touching the buttons we take over the
// calls behind them and leave Steam to draw whatever install-state.ts says.
//
// Every one falls through to Steam's own implementation for anything that isn't
// ours: these are global, and real Steam downloads go through them too.

/** Split a selection into our games and Steam's - a multi-select can be both. */
function partition(appIds: number[] | undefined) {
  const ours: number[] = [];
  const theirs: number[] = [];

  for (const appId of appIds ?? []) {
    (library.getByAppId(appId) ? ours : theirs).push(appId);
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
  RemoveFromDownloadList(appId: number, clientId?: string): void;
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
      const game = library.getByAppId(first);
      if (game) void wizard.open(first, game.app_name, game.folder_name ?? undefined);

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
          const game = library.getByAppId(appId);
          if (game) void jobs.uninstall(game.app_name);
        }

        return undefined;
      },
    ),

    // Resume, and the Update button on a game with a newer build waiting.
    // legendary has no resume: re-running the command continues it, so the only
    // question is which command this game wants.
    replacePatch(bridge.Downloads, "ResumeAppUpdate", ([appId]: [number, string?]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      if (jobs.get(game.app_name)) void jobs.resume(game.app_name);
      else if (game.installed && game.needs_update) void jobs.update(game.app_name);
      else void jobs.install(game.app_name);

      return undefined;
    }),

    // Cancel, on a download running or queued. Steam drops what it downloaded;
    // we keep it, since Install against a partial download is legendary's
    // resume and there's nothing else that would pick those bytes back up.
    replacePatch(bridge.Downloads, "RemoveFromDownloadList", ([appId]: [number, string?]) => {
      // A finished row's ✕ only takes it off the downloads page.
      if (downloads.dismiss(appId)) return undefined;

      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      void jobs.cancel(game.app_name);
      return undefined;
    }),

    // "Pause all downloads", which carries no appid even when one tile's Pause
    // button called it. So ours pause together and Steam's are left to Steam.
    replacePatch(bridge.Downloads, "EnableAllDownloads", ([enabled]: [boolean, string?]) => {
      if (enabled) {
        for (const job of jobs.paused()) void jobs.resume(job.app_name);
      } else {
        void jobs.pauseAll();
      }

      return callOriginal;
    }),
  ];

  console.debug("Registered the install patches");
  return () => {
    for (const patch of patches) patch.unpatch();
  };
}
