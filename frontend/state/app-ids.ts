import { createStore } from "./storage";

// The mapping between Epic's app names and the Steam appids we were handed when
// each shortcut was created. Everything else - artwork, install state, launch -
// is keyed off it, so losing it means orphaned shortcuts nobody can reconcile.
//
// Versioned so a change to how shortcuts are made throws away a map pointing at
// shortcuts built the old way.
const store = createStore<number>("epic-games:app-ids:v1");

/** Every Epic game we've created a shortcut for, as app name -> Steam appid. */
export const getAll = store.getAll;

/** The Steam appid for an Epic game, if there's a shortcut for it. */
export const getAppId = store.get;

export const setAppId = store.set;

export const removeAppName = store.remove;

/**
 * Drop entries whose shortcut no longer exists in Steam.
 *
 * Users delete shortcuts by hand, and a stale entry here would make us think a
 * game is already synced and silently skip recreating it.
 */
export function prune(existingAppIds: Set<number>) {
  store.keep((_, appId) => existingAppIds.has(appId));
}
