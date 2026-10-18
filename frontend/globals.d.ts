import { type SteamAppOverview } from "millennium";

// Client globals @steambrew/client doesn't type. None is guaranteed on a given
// build, so the code using them feature tests.

declare global {
  const appStore: {
    allApps: SteamAppOverview[];
    GetAppOverviewByAppID(appId: number): SteamAppOverview | undefined;
  };

  const collectionStore: {
    /** Every overview passes through this before the grid, filters and sort. */
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
    /** Undefined for a filter-based collection, which has no app list. */
    AsDragDropCollection(): { AddApps(apps: SteamAppOverview[]): void } | undefined;
    Save(): Promise<void>;
    Delete(): Promise<void>;
  }

  /** Steam draws each of its windows into a popup, announced through here. */
  const g_PopupManager: {
    GetExistingPopup(name: string): SteamPopup | undefined;
    /** Every open popup by name, menus included. */
    m_mapPopups?: Map<string, SteamPopup>;
    AddPopupCreatedCallback(callback: (popup: SteamPopup) => void): { Unregister(): void };
    AddPopupDestroyedCallback(callback: (popup: SteamPopup) => void): { Unregister(): void };
  };

  interface SteamPopup {
    /** The title Steam gave it, which for menus is an internal name like "Store Supernav". */
    m_strTitle?: string;
    window?: Window;
    root_element?: Element;
  }

  /**
   * The desktop library's router. Big Picture has none, and it only exists once the
   * main window has drawn, so read it off `window`: a bare reference throws until then.
   */
  // oxlint-disable-next-line no-var -- `var` is what puts it on `window`'s type.
  var MainWindowBrowserManager: { m_lastLocation?: { hash: string } } | undefined;

  /** Steam's client notifications: toasts and the tray. */
  // oxlint-disable-next-line no-var -- as above.
  var NotificationStore:
    | {
        /**
         * Where the client delivers each notification: an id, its
         * EClientUINotificationType and the serialized protobuf for that type.
         */
        OnNotification(id: number, type: number, data: Uint8Array): void;
      }
    | undefined;
}

export {};
