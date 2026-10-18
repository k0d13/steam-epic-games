// Steam draws every window into its own popup, the library's included.

const DESKTOP_WINDOW_NAME = "SP Desktop_uid0";
const GAMEPAD_WINDOW_NAME = "SP BPM_uid0";

/**
 * The library's popup, desktop or Big Picture. Pass it to Steam APIs that take a
 * window, whose `findSP()` default doesn't resolve on this build.
 */
export function mainPopup(): SteamPopup | undefined {
  return (
    g_PopupManager?.GetExistingPopup(DESKTOP_WINDOW_NAME) ??
    g_PopupManager?.GetExistingPopup(GAMEPAD_WINDOW_NAME)
  );
}

/**
 * Nudge the router hash so Steam redraws the overviews it otherwise keeps.
 * Coalesced, since each patch in a repaint asks for one.
 */
let nudgeQueued = false;

export function forceFakeLocationChange() {
  if (nudgeQueued) return;
  nudgeQueued = true;

  // A timer, not a frame: SharedJSContext has none of its own.
  setTimeout(() => {
    nudgeQueued = false;

    if (window.MainWindowBrowserManager?.m_lastLocation) {
      window.MainWindowBrowserManager.m_lastLocation.hash = `#${Math.random()}`;
      return;
    }

    // Big Picture has no browser manager; its library is in the popup's opener.
    const opener = mainPopup()?.window?.opener;
    if (opener instanceof Window) opener.location.hash = `#${Math.random()}`;
  }, 16);
}
