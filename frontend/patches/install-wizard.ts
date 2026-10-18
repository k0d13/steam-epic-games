import { callOriginal, findModuleExport, replacePatch } from "millennium";
import * as jobs from "../state/jobs";

// The client only opens its install wizard for real appids, but it's drawn in JS
// from one object, so we write that into GameActionsStore and intercept its buttons.

/** The state the wizard's own configuration page is drawn for. */
const SHOW_CONFIG = 7;

/**
 * Where Epic games go inside a chosen Steam library folder. Laid out like Steam's
 * own `steamapps\common` but kept out of it, since everything in there is
 * Steam's to manage, and a game sold on both stores can share a folder name.
 */
const INSTALL_SUBDIRECTORY = "epicapps\\common";

/** Millennium types these with string sizes, which Steam no longer sends. */
interface InstallFolder {
  nFolderIndex: number;
  strFolderPath: string;
  nFreeSpace: number;
  bIsDefaultFolder: boolean;
  bIsMounted: boolean;
}

/** What the native client sends the wizard; a missing field draws a warning or empty row. */
function createRequest(appId: number, size: number, folder: InstallFolder) {
  return {
    rgApps: [{ nAppID: appId, lDiskSpaceRequiredBytes: size }],
    eInstallState: SHOW_CONFIG,
    nDiskSpaceRequired: size,
    nDiskSpaceAvailable: folder.nFreeSpace,
    nCurrentDisk: 0,
    nTotalDisks: 0,
    bCanChangeInstallFolder: true,
    iInstallFolder: folder.nFolderIndex,
    // -1 is "none"; anything else draws the "a folder is unmounted" notice.
    iUnmountedFolder: -1,
    currentAppID: appId,
    eAppError: 0,
    errorDetail: "",
    bSystemMenuShortcut: false,
    bDesktopShortcut: false,
    bIsBackupInstall: false,
    strPeerContentServer: "",
    bPeerContentServerOnline: false,
    bPeerContentServerAvailable: false,
  };
}

type InstallRequest = ReturnType<typeof createRequest>;

const store = findModuleExport((value) => typeof value?.GetInstallManager === "function") as
  | { m_InstallManager: InstallRequest | null }
  | undefined;
if (!store) console.warn("Steam's install wizard store wasn't found, so Epic games can't install");

/** The game the wizard is currently open for, if it's one of ours. */
let pending: { appName: string; folderName?: string; request: InstallRequest } | undefined;

let folders: InstallFolder[] = [];

/** A fresh object each time: the store wraps what it's given in a mobx proxy. */
function publish() {
  if (store && pending) store.m_InstallManager = { ...pending.request };
}

function close() {
  pending = undefined;
  if (store) store.m_InstallManager = null;
}

/** Edit and redraw ours. The store assigns what this resolves to back over the request. */
function update(change: (request: InstallRequest) => void) {
  if (!pending) return callOriginal;

  change(pending.request);
  publish();
  return Promise.resolve({ ...pending.request });
}

/** Open Steam's install wizard for our game, awaiting the size its space warning needs. */
export async function open(appId: number, appName: string, folderName?: string) {
  if (!store) return;

  const all = (await SteamClient.InstallFolder.GetInstallFolders()) as unknown as InstallFolder[];
  folders = all.filter((folder) => folder.bIsMounted);

  const chosen = folders.find((folder) => folder.bIsDefaultFolder) ?? folders[0];
  if (!chosen) {
    console.warn("Steam reported no install folders");
    return;
  }

  const size = await backend.GetGameSize(appName);
  pending = { appName, folderName, request: createRequest(appId, size?.disk ?? 0, chosen) };
  publish();
}

export function register() {
  const { Installs } = SteamClient;

  // Global, so real Steam installs fall through whenever ours isn't pending.
  const patches = [
    replacePatch(Installs, "SetInstallFolder", ([folderIndex]) =>
      update((request) => {
        const folder = folders.find((candidate) => candidate.nFolderIndex === folderIndex);
        if (!folder) return;
        request.iInstallFolder = folder.nFolderIndex;
        request.nDiskSpaceAvailable = folder.nFreeSpace;
      }),
    ),

    replacePatch(Installs, "SetCreateShortcuts", ([desktop, systemMenu]) =>
      update((request) => {
        request.bDesktopShortcut = desktop;
        request.bSystemMenuShortcut = systemMenu;
      }),
    ),

    // The Install button.
    replacePatch(Installs, "ContinueInstall", () => {
      if (!pending) return callOriginal;

      const { appName, folderName, request } = pending;
      const folder = folders.find((candidate) => candidate.nFolderIndex === request.iInstallFolder);

      if (request.bDesktopShortcut) {
        try {
          SteamClient.Apps.CreateDesktopShortcutForApp(request.currentAppID);
        } catch (reason: unknown) {
          console.warn("Could not create the desktop shortcut", reason);
        }
      }

      close();
      void jobs.install(
        appName,
        folder && `${folder.strFolderPath}\\${INSTALL_SUBDIRECTORY}`,
        folderName,
      );
      return Promise.resolve();
    }),

    replacePatch(Installs, "CancelInstall", () => {
      if (!pending) return callOriginal;

      close();
      return Promise.resolve();
    }),
  ];

  return () => {
    // A stray wizard's buttons would ask the client about an appid it doesn't know.
    if (pending) close();
    for (const patch of patches) patch.unpatch();
  };
}
