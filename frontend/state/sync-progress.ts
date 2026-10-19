import { createValue } from "./primitives";

export interface SyncResult {
  added: number;
  removed: number;
  failed: number;
  // Set when the sync stopped partway, so the counts are not the whole run
  error?: string;
}

interface SyncState {
  active: boolean;
  // A clean up shares the flag, so neither starts while the other runs
  operation?: "sync" | "cleanUp";
  done: number;
  total: number;
  // Kept so a panel opened later can say what the last sync did
  lastResult?: SyncResult;
}

// Lives here rather than in the panel, since a sync outlives the dialog
export const progress = createValue<SyncState>({ active: false, done: 0, total: 0 });
