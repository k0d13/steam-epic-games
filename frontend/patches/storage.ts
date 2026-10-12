import { afterPatch } from "millennium";
import { getLastPlayed } from "../services/playtime";
import * as library from "../state/library";

// Settings > Storage draws one row per app in each library folder's `vecApps`,
// and adds the folder's own totals up into the drive bar. Both come from one
// call, GetInstallFolders, which the native side answers out of Steam's own
// install manifests - so a shortcut is never in it, wherever its files are.
//
// Rather than writing manifests into Steam's library for the native side to
// find, our games are added to that call's answer on the way out. The folder
// store re-reads it on every change Steam announces, so nothing needs
// re-asserting, and nothing of ours is left in Steam's files to clean up.
//
// The row's Uninstall goes through OpenUninstallWizard, which installs.ts
// already routes to legendary. Move has no Epic counterpart and is left alone.

/** One row of the storage page. Every field is read by the row or the sort. */
interface InstallFolderApp {
  nAppID: number;
  strAppName: string;
  strSortAs: string;
  rtLastPlayed: number;
  nUsedSize: number;
  nAppSize: number;
  nDLCSize: number;
  nWorkshopSize: number;
  nStagedSize: number;
  nShaderSize: number;
}

/** Only the fields we touch; the native object carries more. */
interface InstallFolder {
  strFolderPath: string;
  nUsedSize: number;
  nAppSize: number;
  vecApps: InstallFolderApp[];
}

interface InstallFolders {
  GetInstallFolders(): Promise<InstallFolder[]>;
}

/** The store the storage page reads, published on `window` by Steam itself. */
interface InstallFolderStore {
  OnInstallFolderChanges(): Promise<void>;
}

interface Bridge {
  InstallFolder: InstallFolders;
}

/**
 * A path in one spelling. legendary answers with forward slashes, Steam with
 * backslashes, and Windows doesn't care about case.
 */
function normalise(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * The folder a game sits under, if any. The longest match, since one library
 * can be nested inside another's directory.
 */
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

/** Add every installed game of ours to the folder holding it. */
function withOurGames(folders: InstallFolder[]) {
  for (const appId of library.appIdsWithGames()) {
    const game = library.getByAppId(appId);
    if (!game?.installed || !game.install_path) continue;

    const folder = folderFor(folders, game.install_path);
    if (!folder) continue;

    // An answer the native side already had our app in would draw it twice.
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

    // The drive bar is drawn from the folder's totals, not its rows.
    folder.nUsedSize += size;
    folder.nAppSize += size;
  }

  return folders;
}

/**
 * Ask the store to read the folders again, so a change to what's installed
 * reaches an open storage page. Cheap: one native call, no disk scan.
 */
export function refresh() {
  const store = Reflect.get(globalThis, "installFolderStore") as InstallFolderStore | undefined;
  if (typeof store?.OnInstallFolderChanges !== "function") return;

  store.OnInstallFolderChanges().catch((reason: unknown) => {
    console.warn("Could not refresh Steam's install folders", reason);
  });
}

export function register() {
  const bridge = SteamClient as unknown as Bridge;

  const patch = afterPatch(bridge.InstallFolder, "GetInstallFolders", (_args, result) =>
    result.then(withOurGames),
  );

  // The store read the folders before we were here to add to them.
  refresh();

  console.debug("Registered the storage patch");
  return () => {
    patch.unpatch();
    refresh();
  };
}
