import { afterPatch } from "millennium";
import { getLastPlayed } from "../../services/steam/playtime";
import * as library from "../../state/library";

// Storage rows and drive totals come from GetInstallFolders, built from Steam's own
// manifests, so our games are added to its answer rather than written to disk

// legendary and Steam can disagree on slashes; drive-letter paths ignore case, others
// are compared as they are
function normalise(path: string) {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

// The longest match, since libraries can nest
function folderFor(folders: InstallFolder[], installPath: string) {
  const path = normalise(installPath);
  let best: { folder: InstallFolder; length: number } | undefined;

  for (const folder of folders) {
    const root = normalise(folder.strFolderPath);
    if (!path.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.length) best = { folder, length: root.length };
  }

  return best?.folder;
}

// Has the store re-read the folders so an open storage page updates
export function refresh() {
  const store = globalThis.installFolderStore;
  if (typeof store?.OnInstallFolderChanges !== "function") return;

  store.OnInstallFolderChanges().catch((reason: unknown) => {
    console.warn("Could not refresh Steam's install folders", reason);
  });
}

export function register() {
  const patch = afterPatch(SteamClient.InstallFolder, "GetInstallFolders", (_args, result) =>
    result.then((answer) => {
      const folders = answer as unknown as InstallFolder[];

      for (const appId of library.appIdsWithGames()) {
        const game = library.getByAppId(appId);
        if (!game?.installed || !game.install_path) continue;

        const folder = folderFor(folders, game.install_path);
        if (!folder) continue;

        // An answer the native side already had our app in would draw it twice
        if (folder.vecApps.some((app) => app.nAppID === appId)) continue;

        const size = game.install_size ?? 0;
        folder.vecApps.push({
          nAppID: appId,
          strAppName: game.title,
          strSortAs: game.title,
          rtLastPlayed: getLastPlayed(game.app_name),
          nUsedSize: size,
          nAppSize: size,
          nDLCSize: 0,
          nWorkshopSize: 0,
          nStagedSize: 0,
          nShaderSize: 0,
        });

        // The drive bar is drawn from the folder's totals, not its rows
        folder.nUsedSize += size;
        folder.nAppSize += size;
      }

      return answer;
    }),
  );

  // The store read the folders before we were here to add to them
  refresh();
  return () => {
    patch.unpatch();
    refresh();
  };
}
