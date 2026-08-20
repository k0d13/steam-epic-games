import { createStore } from "./storage";

// Epic app names to the Steam appids their shortcuts were given. Artwork,
// install state and launching are all keyed off it, so losing it orphans every
// shortcut. Versioned, so a change to how shortcuts are made starts fresh.
const store = createStore<number>("epic-games:app-ids:v1");

/** Every Epic game we've created a shortcut for, as app name -> Steam appid. */
export const getAll = store.getAll;

/** The Steam appid for an Epic game, if there's a shortcut for it. */
export const getAppId = store.get;

export const setAppId = store.set;

export const removeAppName = store.remove;

/**
 * Drop entries whose shortcut no longer exists in Steam. People delete them by
 * hand, and a stale entry makes us skip recreating the game.
 */
export function prune(existingAppIds: Set<number>) {
  store.keep((_, appId) => existingAppIds.has(appId));
}
