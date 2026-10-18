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

/** One app in the wizard's list, which for us is always exactly one. */
interface InstallRequestApp {
  nAppID: number;
  lDiskSpaceRequiredBytes: number;
}

/** What the native client sends the wizard; a missing field draws a warning or empty row. */
interface InstallRequest {
  rgApps: InstallRequestApp[];
  eInstallState: number;
  nDiskSpaceRequired: number;
  nDiskSpaceAvailable: number;
  nCurrentDisk: number;
  nTotalDisks: number;
  bCanChangeInstallFolder: boolean;
  iInstallFolder: number;
  iUnmountedFolder: number;
  currentAppID: number;
  eAppError: number;
  errorDetail: string;
  bSystemMenuShortcut: boolean;
  bDesktopShortcut: boolean;
  bIsBackupInstall: boolean;
  strPeerContentServer: string;
  bPeerContentServerOnline: boolean;
  bPeerContentServerAvailable: boolean;
}

interface InstallFolder {
  nFolderIndex: number;
  strFolderPath: string;
  nFreeSpace: number;
  bIsDefaultFolder: boolean;
  bIsMounted: boolean;
}

/** The store the dialog reads. */
interface GameActionsStore {
  m_InstallManager: InstallRequest | null;
  GetInstallManager(): InstallRequest | null;
}

// `unknown`, so a patch can also return callOriginal, a symbol.
interface Installs {
  SetInstallFolder(folderIndex: number): unknown;
  SetCreateShortcuts(desktop: boolean, systemMenu: boolean): unknown;
  ContinueInstall(): unknown;
  CancelInstall(): unknown;
}

interface InstallFolders {
  GetInstallFolders(): Promise<InstallFolder[]>;
}

interface Apps {
  CreateDesktopShortcutForApp(appId: number): void;
}

interface Bridge {
  Installs: Installs;
  InstallFolder: InstallFolders;
  Apps: Apps;
}

const store = findModuleExport((value) => typeof value?.GetInstallManager === "function") as
  | GameActionsStore
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

function folderByIndex(index: number) {
  return folders.find((folder) => folder.nFolderIndex === index);
}

/** Open Steam's install wizard for our game, awaiting the size its space warning needs. */
export async function open(appId: number, appName: string, folderName?: string) {
  if (!store) return;

  const bridge = SteamClient as unknown as Bridge;
  folders = (await bridge.InstallFolder.GetInstallFolders()).filter((folder) => folder.bIsMounted);

  const chosen = folders.find((folder) => folder.bIsDefaultFolder) ?? folders[0];
  if (!chosen) {
    console.warn("Steam reported no install folders");
    return;
  }

  const size = await backend.GetGameSize(appName);

  pending = {
    appName,
    folderName,
    request: {
      rgApps: [{ nAppID: appId, lDiskSpaceRequiredBytes: size?.disk ?? 0 }],
      eInstallState: SHOW_CONFIG,
      nDiskSpaceRequired: size?.disk ?? 0,
      nDiskSpaceAvailable: chosen.nFreeSpace,
      nCurrentDisk: 0,
      nTotalDisks: 0,
      bCanChangeInstallFolder: true,
      iInstallFolder: chosen.nFolderIndex,
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
    },
  };

  publish();
}

export function register() {
  const bridge = SteamClient as unknown as Bridge;

  // Global, so real Steam installs fall through whenever ours isn't pending.
  const patches = [
    replacePatch(bridge.Installs, "SetInstallFolder", ([folderIndex]: [number]) => {
      if (!pending) return callOriginal;

      const folder = folderByIndex(folderIndex);
      if (folder) {
        pending.request.iInstallFolder = folder.nFolderIndex;
        pending.request.nDiskSpaceAvailable = folder.nFreeSpace;
        publish();
      }

      // The store assigns whatever this resolves to back over the request.
      return Promise.resolve({ ...pending.request });
    }),

    replacePatch(
      bridge.Installs,
      "SetCreateShortcuts",
      ([desktop, systemMenu]: [boolean, boolean]) => {
        if (!pending) return callOriginal;

        pending.request.bDesktopShortcut = desktop;
        pending.request.bSystemMenuShortcut = systemMenu;
        publish();

        return Promise.resolve({ ...pending.request });
      },
    ),

    // The Install button.
    replacePatch(bridge.Installs, "ContinueInstall", () => {
      if (!pending) return callOriginal;

      const { appName, folderName, request } = pending;
      const folder = folderByIndex(request.iInstallFolder);
      const basePath = folder && `${folder.strFolderPath}\\${INSTALL_SUBDIRECTORY}`;

      if (request.bDesktopShortcut) {
        try {
          bridge.Apps.CreateDesktopShortcutForApp(request.currentAppID);
        } catch (reason: unknown) {
          console.warn("Could not create the desktop shortcut", reason);
        }
      }

      close();
      void jobs.install(appName, basePath, folderName);
      return Promise.resolve();
    }),

    replacePatch(bridge.Installs, "CancelInstall", () => {
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
