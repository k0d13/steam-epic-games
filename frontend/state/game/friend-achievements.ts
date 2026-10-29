import { createCache } from "../primitives";

// Not saved, as the backend keeps these on disk and they go stale as friends play

const STALE_AFTER_MS = 10 * 60 * 1000;

const cache = createCache<FriendAchievements>({
  fetch: (appName, refresh) => backend.GetFriendAchievements(appName, refresh),
  isStale: (_appName, entry) => !!entry && Date.now() - entry.fetched_at * 1000 > STALE_AFTER_MS,
});

export const subscribe = cache.subscribe;
export const get = cache.get;
export const ensure = cache.ensure;
