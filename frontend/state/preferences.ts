import { createEmitter } from "./emitter";
import { createStore } from "./storage";

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

const emitter = createEmitter();
export const subscribe = emitter.subscribe;

/** Rebuilt on change only, so useSyncExternalStore sees a stable snapshot. */
let snapshot: Preferences = { ...DEFAULTS, ...store.getAll() };

export function get(): Preferences {
  return snapshot;
}

export function set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  store.set(key, value);
  snapshot = { ...snapshot, [key]: value };
  emitter.emit();
}
