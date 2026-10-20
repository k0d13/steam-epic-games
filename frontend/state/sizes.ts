import { createCache } from "./primitives";

const cache = createCache<GameSize>({
  persist: "epic-games:sizes:v1",
  fetch: (appName, refresh) => backend.GetGameSize(appName, refresh),
});

export const subscribe = cache.subscribe;
export const get = cache.get;
export const ensure = cache.ensure;

export async function clear() {
  await backend.ClearGameSizes();
  cache.clear();
}

// The backend's cache can't tell a new build shipped, so a finished job invalidates
export const forget = cache.invalidate;
