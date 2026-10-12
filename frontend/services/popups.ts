// Steam draws every window into its own popup, so DOM patches must reach each one.

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

/** Call back for every popup, open ones included; a returned teardown runs on destroy. */
export function onPopupCreate(handleOpen: (popup: SteamPopup) => void | VoidFunction): () => void {
  const popups = g_PopupManager;
  if (!popups) return () => {};

  // Per registration, so two features watching the same popup keep their own.
  const teardowns = new WeakMap<SteamPopup, void | VoidFunction>();

  function onCreate(popup: SteamPopup) {
    teardowns.set(popup, handleOpen(popup));
  }

  function onDestroy(popup: SteamPopup) {
    teardowns.get(popup)?.();
    teardowns.delete(popup);
  }

  for (const name of [DESKTOP_WINDOW_NAME, GAMEPAD_WINDOW_NAME]) {
    const existing = popups.GetExistingPopup(name);
    if (existing) onCreate(existing);
  }

  const { Unregister: removeCreate } = popups.AddPopupCreatedCallback(onCreate);
  const { Unregister: removeDestroy } = popups.AddPopupDestroyedCallback(onDestroy);

  return () => {
    removeCreate();
    removeDestroy();
  };
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

    if (MainWindowBrowserManager?.m_lastLocation) {
      MainWindowBrowserManager.m_lastLocation.hash = `#${Math.random()}`;
      return;
    }

    // Big Picture has no browser manager; its library is in the popup's opener.
    const opener = mainPopup()?.window?.opener;
    if (opener instanceof Window) opener.location.hash = `#${Math.random()}`;
  }, 16);
}
