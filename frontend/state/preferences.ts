import { createStore, createValue } from "./primitives";

// What the panel's toggles remember. Each is applied after every sync, so it
// holds for games added later too.

export interface Preferences {
  /** Add new purchases and drop games that left the account, once anything is synced. */
  autoSync: boolean;
  /** Keep every Epic shortcut in the "Epic Games" collection. */
  collection: boolean;
  /** Hide the Epic copy of games also owned on Steam. */
  hideDuplicates: boolean;
}

const DEFAULTS: Preferences = { autoSync: true, collection: false, hideDuplicates: false };

const store = createStore<boolean>("epic-games:preferences:v1");

/** Rebuilt on change only, so useSyncExternalStore sees a stable snapshot. */
const preferences = createValue<Preferences>({ ...DEFAULTS, ...store.getAll() });

export const subscribe = preferences.subscribe;
export const get = preferences.get;

export function set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  store.set(key, value);
  preferences.update({ [key]: value } as Pick<Preferences, K>);
}
