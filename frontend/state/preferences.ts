import { createStore, createValue } from "./primitives";

// Applied after every sync, so each holds for games added later too
export interface Preferences {
  autoSync: boolean;
  collection: boolean;
  hideDuplicates: boolean;
}

const DEFAULTS: Preferences = { autoSync: true, collection: false, hideDuplicates: false };

const store = createStore<boolean>("epic-games:preferences:v1");

const preferences = createValue<Preferences>({ ...DEFAULTS, ...store.getAll() });

export const subscribe = preferences.subscribe;
export const get = preferences.get;

export function set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  store.set(key, value);
  preferences.update({ [key]: value } as Pick<Preferences, K>);
}
