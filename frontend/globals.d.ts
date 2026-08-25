import { type SteamAppOverview } from "@steambrew/client";

// The client globals the library is built from, which @steambrew/client either
// doesn't type or types only the parts of that it uses itself. Declared here
// rather than wrapped, so the code reads as the same globals Steam's own does.
//
// Only the members we touch, and none of them are guaranteed on a given client
// build - the code using them feature tests rather than trusting these.

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
