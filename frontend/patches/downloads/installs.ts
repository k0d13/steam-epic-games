import { callOriginal, replacePatch } from "millennium";
import * as jobs from "../../state/jobs";
import * as library from "../../state/library";
import * as downloads from "./downloads";
import * as wizard from "./install-wizard";

// Steam's install buttons call a few global SteamClient functions, so we take those
// over for our games and fall through for everything else

// A multi-select can hold both our games and Steam's
function partition(appIds: number[] | undefined) {
  const ours: number[] = [];
  const theirs: number[] = [];

  for (const appId of appIds ?? []) {
    (library.getByAppId(appId) ? ours : theirs).push(appId);
  }

  return { ours, theirs };
}

export function register() {
  const { Installs, Downloads } = SteamClient;
  const patches = [
    // The native wizard ignores non-Steam appids, so install-wizard opens it from JS
    replacePatch(Installs, "OpenInstallWizard", ([appIds]) => {
      const { ours, theirs } = partition(appIds);
      if (ours.length === 0) return callOriginal;

      if (theirs.length > 0) Installs.OpenInstallWizard(theirs);

      // One dialog, so a multi-select only opens it for the first Epic game
      const [first] = ours as [number, ...number[]];
      const game = library.getByAppId(first);
      if (game) void wizard.open(first, game.app_name, game.folder_name ?? undefined);

      return undefined;
    }),

    // Steam's uninstall dialog calls this on confirm, so the dialog stays Steam's
    replacePatch(Installs, "OpenUninstallWizard", ([appIds, dontPrompt]) => {
      const { ours, theirs } = partition(appIds);
      if (ours.length === 0) return callOriginal;

      if (theirs.length > 0) Installs.OpenUninstallWizard(theirs, dontPrompt);

      for (const appId of ours) {
        const game = library.getByAppId(appId);
        if (game) void jobs.uninstall(game.app_name);
      }

      return undefined;
    }),

    // Resume, and Update on a game with a newer build; re-running the command resumes
    replacePatch(Downloads, "ResumeAppUpdate", ([appId]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      if (jobs.get(game.app_name)) void jobs.resume(game.app_name);
      else if (game.installed && game.needs_update) void jobs.update(game.app_name);
      else void jobs.install(game.app_name);

      return undefined;
    }),

    // Cancel keeps the partial download, since Install resumes from it
    replacePatch(Downloads, "RemoveFromDownloadList", ([appId]) => {
      // A finished row's ✕ only takes it off the downloads page
      if (downloads.dismiss(appId)) return undefined;

      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      void jobs.cancel(game.app_name);
      return undefined;
    }),

    // Carries no appid even from one tile's Pause, so all of ours pause together
    replacePatch(Downloads, "EnableAllDownloads", ([enabled]) => {
      if (enabled) {
        for (const job of jobs.paused()) void jobs.resume(job.app_name);
      } else {
        void jobs.pauseAll();
      }

      return callOriginal;
    }),
  ];

  return () => patches.forEach((patch) => patch.unpatch());
}
