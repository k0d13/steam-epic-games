import { createStore } from "./primitives";

// Steam sets this bit on the appids it hands non-Steam shortcuts
const SHORTCUT_APPID_BIT = 0x80000000;

export function isShortcut(appId: number) {
  return appId >= SHORTCUT_APPID_BIT;
}

// FNV-1a, for the ids we make up for DLC and Epic friends
export function hashId(text: string) {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

// Epic app name to shortcut appid; losing it orphans every shortcut, so bump the
// version when shortcuts are made differently
const store = createStore<number>("epic-games:app-ids:v1");

export const getAll = store.getAll;
export const getAppId = store.get;
export const setAppId = store.set;
export const removeAppName = store.remove;
export const clear = store.clear;

// Drops entries whose shortcut was deleted by hand, or we'd never recreate it
export function prune(existingAppIds: Set<number>) {
  store.keep((_, appId) => existingAppIds.has(appId));
}
