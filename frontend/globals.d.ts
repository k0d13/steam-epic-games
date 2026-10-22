import { type AppDetails, type SteamAppOverview } from "millennium";

// Client globals @steambrew/client doesn't type; none is guaranteed on a given build,
// so the code using them feature tests

declare global {
  const appStore: {
    allApps: SteamAppOverview[];
    GetAppOverviewByAppID(appId: number): SteamAppOverview | undefined;
  };

  const collectionStore: {
    // Every overview passes through this before the grid, filters and sort
    OnAppOverviewChange(apps: SteamAppOverview[]): void;
    BIsHidden(appId: number): boolean;
    SetAppsAsHidden(appIds: number[], hidden: boolean): void;
    userCollections: SteamCollection[];
    NewUnsavedCollection(
      name: string,
      filter: undefined,
      apps: SteamAppOverview[],
    ): SteamCollection;
  };

  interface SteamCollection {
    id: string;
    displayName: string;
    allApps: SteamAppOverview[];
    // Undefined for a filter-based collection, which has no app list
    AsDragDropCollection(): { AddApps(apps: SteamAppOverview[]): void } | undefined;
    Save(): Promise<void>;
    Delete(): Promise<void>;
  }

  const g_PopupManager: {
    GetExistingPopup(name: string): SteamPopup | undefined;
    m_mapPopups?: Map<string, SteamPopup>;
    AddPopupCreatedCallback(callback: (popup: SteamPopup) => void): { Unregister(): void };
    AddPopupDestroyedCallback(callback: (popup: SteamPopup) => void): { Unregister(): void };
  };

  interface SteamPopup {
    // For menus an internal name like "Store Supernav"
    m_strTitle?: string;
    window?: Window;
    root_element?: Element;
  }

  // Desktop library's router, absent in Big Picture and until the main window has drawn,
  // so read it off `window` (`var` is what puts these on its type)
  // oxlint-disable-next-line no-var
  var MainWindowBrowserManager: { m_lastLocation?: { hash: string } } | undefined;

  // oxlint-disable-next-line no-var
  var appDetailsStore:
    | {
        m_mapAppData: Map<number, AppDataSlot>;
        GetAppData(appId: number): AppDataSlot;
        // Callable but not patchable: a non-writable mobx action
        AppDetailsChanged(details: AppDetails): void;
      }
    | undefined;

  interface AppDataSlot {
    details?: AppDetails;
    associationData?: {
      rgDevelopers: AppAssociation[];
      rgPublishers: AppAssociation[];
      rgFranchises: AppAssociation[];
    };
    descriptionsData?: { strFullDescription: string; strSnippet: string };
  }

  interface AppAssociation {
    strName: string;
    strURL: string;
  }

  // OnNotification takes an id, its EClientUINotificationType and the serialized protobuf
  // oxlint-disable-next-line no-var
  var NotificationStore:
    | { OnNotification(id: number, type: number, data: Uint8Array): void }
    | undefined;

  // The store behind each game page's activity feed
  // oxlint-disable-next-line no-var
  var appActivityStore:
    | { FetchLatestActivityFromServer(appId: number, latest: boolean): Promise<void> }
    | undefined;

  // oxlint-disable-next-line no-var
  var appAchievementProgressCache:
    | {
        BGameHasAchievements(appId: number): boolean;
        GetAchievementProgress(appId: number): number;
      }
    | undefined;

  // oxlint-disable-next-line no-var
  var installFolderStore: { OnInstallFolderChanges(): Promise<void> } | undefined;

  // One EAppUpdateProgress stage
  interface UpdateProgress {
    bytes_in_progress: number;
    bytes_total: number;
    estimated_time_remaining_sec: number;
  }

  // Only the fields we touch; the real overview carries several dozen
  interface DownloadOverview {
    update_appid: number;
    update_state: string;
    update_is_install: boolean;
    update_is_upload: boolean;
    overall_percent_complete: number;
    overall_estimated_time_remaining_sec: number;
    update_network_bytes_per_second: number;
    paused: boolean;
    progress?: UpdateProgress[];
  }

  // One row of the downloads page; every field is read by the page or its sort
  interface DownloadItem {
    appid: number;
    active: boolean;
    paused: boolean;
    completed: boolean;
    completed_time: number;
    // -1 for an item that isn't in the queue
    queue_index: number;
    deferred_time: number;
    buildid: number;
    target_buildid: number;
    update_result: number;
    update_error: string;
    launch_on_completion: boolean;
    is_invalid_os_type: boolean;
    update_type_info: { has_update: boolean; completed: boolean; progress: UpdateProgress[] }[];
  }

  // oxlint-disable-next-line no-var
  var downloadsStore:
    | {
        readonly AllTransfers: DownloadItem[];
        readonly BIsViewingLocalClient: boolean;
        LocalDownloadOverview?: DownloadOverview;
        // Overviews by client, observable; the local one is under the local client's id
        m_DownloadOverview?: Map<unknown, DownloadOverview>;
        m_fnCallbackDownloadItemsChanged?: { Dispatch(changed: boolean): void };
      }
    | undefined;

  // Millennium types the sizes as strings, which Steam no longer sends
  interface InstallFolder {
    nFolderIndex: number;
    strFolderPath: string;
    nFreeSpace: number;
    nUsedSize: number;
    nAppSize: number;
    bIsDefaultFolder: boolean;
    bIsMounted: boolean;
    vecApps: InstallFolderApp[];
  }

  // One row of the storage page
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
}

export {};
