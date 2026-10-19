import { createCache } from "./primitives";

// Like state/sizes.ts, answers from memory for Steam's render path. What the game
// info panel shows doesn't change in a session, so an answer is kept as it is.

const cache = createCache<GameInfo>({
  fetch: (appName, refresh) => backend.GetGameInfo(appName, refresh),
});

/** Fires when a game's info arrives, so whatever is showing it can repaint. */
export const subscribe = cache.subscribe;

/** The info for a game, if we already have it. Never blocks and never fetches. */
export const get = cache.get;

/** Make sure we're getting this game's info. Safe to call every render. */
export const ensure = cache.ensure;
