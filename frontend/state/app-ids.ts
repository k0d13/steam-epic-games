import { createStore } from "./storage";

/** Steam sets this bit on the appids it hands non-Steam shortcuts, which ours are. */
const SHORTCUT_APPID_BIT = 0x80000000;

/** Is this a non-Steam shortcut's appid, ours or anyone's? */
export const isShortcut = (appId: number) => appId >= SHORTCUT_APPID_BIT;

// Epic app name to shortcut appid; losing it orphans every shortcut. Versioned, so
// a change to how shortcuts are made starts fresh.
const store = createStore<number>("epic-games:app-ids:v1");

/** Every Epic game we've created a shortcut for, as app name -> Steam appid. */
export const getAll = store.getAll;

/** The Steam appid for an Epic game, if there's a shortcut for it. */
export const getAppId = store.get;

export const setAppId = store.set;

export const removeAppName = store.remove;

export const clear = store.clear;

/** Drop entries whose shortcut was deleted by hand, or we'd never recreate it. */
export function prune(existingAppIds: Set<number>) {
  store.keep((_, appId) => existingAppIds.has(appId));
}
