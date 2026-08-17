import { callOriginal, replacePatch } from "@steambrew/client";
import { logger } from "../index";
import rpc from "../rpc";
import { findExport } from "../services/modules";
import * as jobs from "../state/jobs";

// Steam's install wizard is the dialog the client asks for through
// SteamClient.Installs.RegisterForShowInstallWizard, and the native half of
// that only knows real appids - so an Epic game can never make the client raise
// it. What the native half actually sends is one plain object, and every part
// of the dialog is drawn from it in JS:
//
//   const e = useMobx(() => GameActionsStore.GetInstallManager());
//   switch (e.eInstallState) { case k_EInstallMgrStateShowConfig: <InstallConfig installRequest={e}/>
//
// So the wizard is opened by writing that object into the store ourselves. The
// dialog is then Steam's own, in Steam's language, inside the main window where
// it belongs - the drive list, the space warnings, the shortcut checkboxes and
// the Install button all come free.
//
// Its buttons call four SteamClient.Installs functions, and those are plain
// properties, so they're intercepted the same way the uninstall flow is: the
// dialog is Steam's, the part that touches files is ours.

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
 * What the native client sends the wizard. Every field is read somewhere in the
 * dialog, and a missing one renders as a warning or an empty row, so this is
 * built whole rather than partially.
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

/** The store the dialog reads. Only the one field matters to us. */
interface GameActionsStore {
  m_InstallManager: InstallRequest | null;
  GetInstallManager(): InstallRequest | null;
}

// Declared as returning `unknown` rather than a promise so a patch can return
// callOriginal, which is a symbol, from the same function.
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

let store: GameActionsStore | undefined;
let searched = false;

/**
 * The store singleton, found by source rather than by name: the class is a
 * module-local binding, but the store instance is exported, and the getter's
 * body is a string Steam's own build can't rename.
 */
function getStore(): GameActionsStore | undefined {
  if (!searched) {
    searched = true;
    store = findExport("GetInstallManager(){return this.m_InstallManager}", isGameActionsStore);
    if (!store) logger.warn("Steam's install wizard store wasn't found");
  }
  return store;
}

/** The game the wizard is currently open for, if it's one of ours. */
let pending: { appName: string; folderName?: string; request: InstallRequest } | undefined;

let folders: InstallFolder[] = [];

/**
 * Hand the store a fresh object every time.
 *
 * The store's field is a deep mobx observable, so what it holds is a proxy
 * around whatever it was given rather than our object - mutating ours after the
 * fact repaints nothing. Assigning a copy is what the dialog notices.
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
 * Open Steam's install wizard for one of our games.
 *
 * The size is awaited rather than filled in later: it's what the dialog sizes
 * its warning and its Install button against, and it's cached in the backend
 * after the first look at the game's page, which is where this is opened from.
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
      // -1 is "none", and any other value draws the "a folder is unmounted"
      // notice. Same for the peer content server fields below.
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

  // All four are what the dialog's own buttons call, and all four are global -
  // a real Steam install is going through them whenever ours isn't.
  const patches = [
    replacePatch(bridge.Installs, "SetInstallFolder", ([folderIndex]: [number]) => {
      if (!pending) return callOriginal;

      const folder = folderByIndex(folderIndex);
      if (folder) {
        pending.request.iInstallFolder = folder.nFolderIndex;
        pending.request.nDiskSpaceAvailable = folder.nFreeSpace;
        publish();
      }

      // The store assigns whatever this resolves to straight back over the
      // request, so it has to be the request rather than nothing.
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
    // A wizard left on screen after the patches are gone has buttons that talk
    // to the native client about an appid it has never heard of.
    if (pending) close();
    for (const patch of patches) patch.unpatch();
  };
}
