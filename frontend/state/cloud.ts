import { createSignal } from "./primitives";

// Each game's cloud saves by app name, as the backend last found them, and what's
// moving them right now. The backend decides when they conflict; Steam's dialogs,
// through game-page/cloud, put that to the user

export type Direction = "upload" | "download";
export type Activity = "checking" | Direction;

const signal = createSignal();
const entries = new Map<string, CloudSaves>();
const activities = new Map<string, Activity>();
const running = new Map<string, Promise<CloudSaves>>();
// Games compared with the cloud this session
const checked = new Set<string>();

export const subscribe = signal.subscribe;

export function get(appName: string) {
  return entries.get(appName);
}

export function getActivity(appName: string) {
  return activities.get(appName);
}

function store(entry: CloudSaves) {
  entries.set(entry.app_name, entry);
  signal.emit();
}

function setActivity(appName: string, activity: Activity | undefined) {
  if (activity) activities.set(appName, activity);
  else activities.delete(appName);
  signal.emit();
}

export async function load() {
  // Lua sends {} for an empty list; Object.values reads both
  for (const entry of Object.values(await backend.GetCloudSaves())) {
    entries.set(entry.app_name, entry);
  }
  signal.emit();
}

async function check(appName: string) {
  checked.add(appName);
  setActivity(appName, "checking");
  const result = await backend.CheckSaves(appName);
  store(result);
  return result;
}

async function run(appName: string, direction: Direction | undefined) {
  if (!direction) {
    const result = await check(appName);
    if (result.status !== "upload" && result.status !== "download") return result;
    direction = result.status;
  }

  setActivity(appName, direction);
  const synced = await backend.SyncSaves(appName, direction);
  store(synced);
  return synced;
}

// Checks first, then moves the saves whichever way the check found; a `direction`
// skips the check, to settle a conflict. A conflict or failure comes back for the caller
export function sync(appName: string, direction?: Direction) {
  return hold(appName, () => run(appName, direction));
}

// Compares without moving anything, once a session, so an opened page has a status
// before its first launch, and another machine's uploads show without one
export function ensure(appName: string) {
  if (checked.has(appName) || running.has(appName)) return;
  void hold(appName, () => check(appName));
}

// One at a time per game, as a second would race the first over the same files
function hold(appName: string, work: () => Promise<CloudSaves>) {
  const held = running.get(appName);
  if (held) return held;

  const promise = work()
    .catch((reason: unknown): CloudSaves => {
      console.warn("Cloud save sync failed", { appName, reason });
      const failed = {
        app_name: appName,
        status: "failed",
        local_at: null,
        remote_at: null,
        synced_at: entries.get(appName)?.synced_at ?? null,
        error: String(reason),
      };
      store(failed);
      return failed;
    })
    .finally(() => {
      running.delete(appName);
      setActivity(appName, undefined);
    });

  running.set(appName, promise);
  return promise;
}
