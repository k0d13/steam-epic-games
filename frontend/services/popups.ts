// Steam draws each of its windows into a popup of its own, and anything that
// touches the DOM has to be applied to every one of them - the library window,
// a detached one, a context menu. `g_PopupManager` is where they're announced.

const DESKTOP_WINDOW_NAME = "SP Desktop_uid0";
const GAMEPAD_WINDOW_NAME = "SP BPM_uid0";

/**
 * The popup the library is drawn in, desktop or Big Picture. Steam's own APIs
 * that take a window - `showModal`, its dialogs - default to `findSP()`, which
 * doesn't resolve on this build, so this is passed explicitly.
 */
export function mainPopup(): SteamPopup | undefined {
  return (
    g_PopupManager?.GetExistingPopup(DESKTOP_WINDOW_NAME) ??
    g_PopupManager?.GetExistingPopup(GAMEPAD_WINDOW_NAME)
  );
}

const CLOSE_CALLBACKS = Symbol("epic-games.popup-close");

interface Handlers {
  /** Run now, and again whenever the popup is shown. */
  onOpen(callback: VoidFunction): void;
  onClose(callback: VoidFunction): void;
}

/**
 * Call back for every popup, the ones already open included. The callback may
 * return its own teardown, which runs with the ones given to `onClose`.
 *
 * @returns Cleanup that unregisters from the manager.
 */
export function onPopupCreate(
  handleOpen: (popup: SteamPopup, handlers: Handlers) => void | VoidFunction,
): () => void {
  const popups = g_PopupManager;
  if (!popups) return () => {};

  function onCreate(popup: SteamPopup) {
    const closeCallbacks = new Set<VoidFunction>();
    Reflect.set(popup, CLOSE_CALLBACKS, closeCallbacks);

    const onClose = handleOpen(popup, {
      onOpen: (callback) => callback(),
      onClose: (callback) => closeCallbacks.add(callback),
    });

    if (onClose) closeCallbacks.add(onClose);
  }

  function onDestroy(popup: SteamPopup) {
    const closeCallbacks = Reflect.get(popup, CLOSE_CALLBACKS) as Set<VoidFunction> | undefined;
    for (const callback of closeCallbacks ?? []) callback();
    Reflect.deleteProperty(popup, CLOSE_CALLBACKS);
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
 * Nudge the library window's router hash so everything keyed off the location
 * re-renders. Steam builds its app overviews once and keeps them, so a
 * corrected one is only drawn after something asks for a repaint.
 *
 * Coalesced, because a repaint runs several patches and each asks for one. A
 * hash change re-renders the library and everything else keyed off the
 * location, Millennium re-applying a theme's patches included.
 */
let nudgeQueued = false;

export function forceFakeLocationChange() {
  if (nudgeQueued) return;
  nudgeQueued = true;

  // A timer, not a frame: SharedJSContext has none of its own.
  setTimeout(() => {
    nudgeQueued = false;
    nudge();
  }, 16);
}

function nudge() {
  if (MainWindowBrowserManager?.m_lastLocation) {
    MainWindowBrowserManager.m_lastLocation.hash = `#${Math.random()}`;
    return;
  }

  // Big Picture has no browser manager; its library is in the popup's opener.
  const opener = mainPopup()?.window?.opener;
  if (opener instanceof Window) opener.location.hash = `#${Math.random()}`;
}
