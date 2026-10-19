import { createCache } from "./primitives";

// Like state/sizes.ts, answers from memory for Steam's render path. What the game
// info panel shows rarely changes, so a saved answer is served and the backend,
// which knows how old its own copy is, is asked once a session.

const cache = createCache<GameInfo>({
  persist: "epic-games:info:v1",
  fetch: (appName, refresh) => backend.GetGameInfo(appName, refresh),
});

/** Fires when a game's info arrives, so whatever is showing it can repaint. */
export const subscribe = cache.subscribe;

/** The info for a game, if we already have it. Never blocks and never fetches. */
export const get = cache.get;

/** Make sure we're getting this game's info. Safe to call every render. */
export const ensure = cache.ensure;
