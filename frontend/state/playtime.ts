import * as preferences from "./preferences";
import { createSignal } from "./primitives";

// Play time by app name, from our own record and Epic's, which outlive the shortcuts
// Steam keeps its own under; the overviews show whichever is larger

const signal = createSignal();
const entries = new Map<string, Playtime>();

export const subscribe = signal.subscribe;

export function get(appName: string) {
  return entries.get(appName);
}

function store(list: Playtime[]) {
  let changed = false;
  for (const entry of list) {
    const held = entries.get(entry.app_name);
    if (held?.seconds === entry.seconds && held.last_played === entry.last_played) continue;
    entries.set(entry.app_name, entry);
    changed = true;
  }
  if (changed) signal.emit();
}

// `refresh` asks Epic, which is a round trip, otherwise its last answer is used
export async function load(refresh = false) {
  // Lua sends {} for an empty list; Object.values reads both
  store(Object.values(await backend.GetPlaytime(refresh, preferences.get().reportPlaytime)));
}

export async function record(appName: string, startedAt: number, endedAt: number) {
  const report = preferences.get().reportPlaytime;
  store([await backend.RecordSession(appName, startedAt, endedAt, report)]);
}
