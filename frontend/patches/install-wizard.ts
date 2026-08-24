import { callOriginal, replacePatch } from "@steambrew/client";
import { logger } from "../index";
import rpc from "../rpc";
import { findExport } from "../services/modules";
import { memo } from "../services/once";
import * as jobs from "../state/jobs";

// The client only raises its install wizard for real appids, so an Epic game
// can never make it appear. But all the native side sends is one plain object,
// and the dialog is drawn from it in JS - so writing that object into
// GameActionsStore opens the wizard ourselves, in Steam's own language and
// window, with the drive list, space warnings and shortcut checkboxes free.
//
// Its buttons call four SteamClient.Installs functions, intercepted the same
// way the uninstall flow is: the dialog is Steam's, the file work is ours.

/** The state the wizard's own configuration page is drawn for. */
const SHOW_CONFIG = 7;

/** Where Epic games go inside a chosen Steam library folder. */
const INSTALL_SUBDIRECTORY = "Epic Games";

/** One app in the wizard's list, which for us is always exactly one. */
interface InstallRequestApp {
  nAppID: number;
  lDiskSpaceRequiredBytes: number;
}

/**
 * What the native client sends the wizard. Every field is read somewhere, and a
 * missing one draws a warning or an empty row, so it's built whole.
 */
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

// `unknown` rather than a promise, so a patch can return callOriginal - a
// symbol - from the same function.
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

function isGameActionsStore(value: unknown): value is GameActionsStore {
  return typeof (value as GameActionsStore | null)?.GetInstallManager === "function";
}

/**
 * The store singleton, found by the source of one of its getters, which is a
 * string Steam's build can't rename.
 */
const getStore = memo(() => {
  const store = findExport("GetInstallManager(){return this.m_InstallManager}", isGameActionsStore);
  if (!store) logger.warn("Steam's install wizard store wasn't found");
  return store;
});

/** The game the wizard is currently open for, if it's one of ours. */
let pending: { appName: string; folderName?: string; request: InstallRequest } | undefined;

let folders: InstallFolder[] = [];

/**
 * Hand the store a fresh object every time. Its field is a deep mobx
 * observable, so it holds a proxy around what it was given - mutating ours
 * afterwards repaints nothing.
 */
function publish() {
  const current = getStore();
  if (current && pending) current.m_InstallManager = { ...pending.request };
}

function close() {
  pending = undefined;

  const current = getStore();
  if (current) current.m_InstallManager = null;
}

function folderByIndex(index: number) {
  return folders.find((folder) => folder.nFolderIndex === index);
}

/**
 * Open Steam's install wizard for one of our games. The size is awaited, since
 * the dialog sizes its space warning against it - by this point it's usually
 * cached from the game's page anyway.
 */
export async function open(appId: number, appName: string, folderName?: string) {
  const current = getStore();
  if (!current) return false;

  const bridge = SteamClient as unknown as Bridge;
  folders = (await bridge.InstallFolder.GetInstallFolders()).filter((folder) => folder.bIsMounted);
  if (folders.length === 0) {
    logger.warn("Steam reported no install folders");
    return false;
  }

  const chosen = folders.find((folder) => folder.bIsDefaultFolder) ?? folders[0];
  if (!chosen) return false;

  const size = await rpc.GetGameSize(appName);

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
  return true;
}

export function register() {
  const bridge = SteamClient as unknown as Bridge;

  // What the dialog's buttons call. All global, so a real Steam install goes
  // through them whenever ours isn't.
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
          logger.warn("Could not create the desktop shortcut", reason);
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

  logger.debug("Registered the install wizard patches");
  return () => {
    // A wizard left on screen once the patches are gone has buttons that ask
    // the native client about an appid it has never heard of.
    if (pending) close();
    for (const patch of patches) patch.unpatch();
  };
}
