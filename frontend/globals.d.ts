import { type SteamAppOverview } from "millennium";

// Client globals @steambrew/client doesn't type. None is guaranteed on a given
// build, so the code using them feature tests.

declare global {
  const appStore: {
    allApps: SteamAppOverview[];
    GetAppOverviewByAppID(appId: number): SteamAppOverview | undefined;
  };

  /** Every overview passes through this before the grid, filters and sort. */
  const collectionStore: {
    OnAppOverviewChange(apps: SteamAppOverview[]): void;
  };

  /** Steam draws each of its windows into a popup, announced through here. */
  const g_PopupManager: {
    GetExistingPopup(name: string): SteamPopup | undefined;
    AddPopupCreatedCallback(callback: (popup: SteamPopup) => void): { Unregister(): void };
    AddPopupDestroyedCallback(callback: (popup: SteamPopup) => void): { Unregister(): void };
  };

  interface SteamPopup {
    window?: Window;
    root_element?: Element;
  }

  /** The desktop library's router. Big Picture has none. */
  const MainWindowBrowserManager: { m_lastLocation?: { hash: string } } | undefined;
}

export {};
