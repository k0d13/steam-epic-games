import { callOriginal, replacePatch } from "millennium";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import * as downloads from "./downloads";
import * as wizard from "./install-wizard";

// Steam's install buttons call a few global SteamClient functions, so we take those
// over for our games and fall through for everything else.

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
    // The native wizard ignores non-Steam appids, so install-wizard.ts opens it from JS.
    replacePatch(bridge.Installs, "OpenInstallWizard", ([appIds]: [number[]]) => {
      const { ours, theirs } = partition(appIds);
      if (ours.length === 0) return callOriginal;

      if (theirs.length > 0) bridge.Installs.OpenInstallWizard(theirs);

      // One dialog, so a multi-select only opens it for the first Epic game.
      const [first] = ours as [number, ...number[]];
      const game = library.getByAppId(first);
      if (game) void wizard.open(first, game.app_name, game.folder_name ?? undefined);

      return undefined;
    }),

    // Called by Steam's uninstall dialog on confirm, so the dialog stays Steam's.
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

    // Resume, and Update on a game with a newer build. Re-running the command resumes.
    replacePatch(bridge.Downloads, "ResumeAppUpdate", ([appId]: [number, string?]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      if (jobs.get(game.app_name)) void jobs.resume(game.app_name);
      else if (game.installed && game.needs_update) void jobs.update(game.app_name);
      else void jobs.install(game.app_name);

      return undefined;
    }),

    // Cancel keeps the partial download, since Install resumes from it.
    replacePatch(bridge.Downloads, "RemoveFromDownloadList", ([appId]: [number, string?]) => {
      // A finished row's ✕ only takes it off the downloads page.
      if (downloads.dismiss(appId)) return undefined;

      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      void jobs.cancel(game.app_name);
      return undefined;
    }),

    // Carries no appid even from one tile's Pause, so all of ours pause together.
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
