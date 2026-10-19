import { createCache } from "./primitives";

// What the info panel shows rarely changes, so a saved answer is served and the
// backend is asked once a session
const cache = createCache<GameInfo>({
  persist: "epic-games:info:v4",
  fetch: (appName, refresh) => backend.GetGameInfo(appName, refresh),
});

export const subscribe = cache.subscribe;
export const get = cache.get;
export const ensure = cache.ensure;
