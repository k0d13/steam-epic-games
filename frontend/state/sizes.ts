import { createCache } from "./primitives";

// Answers from memory for Steam's render path; an unknown game starts a fetch and
// notifies subscribers when it lands.

const cache = createCache<GameSize>({
  fetch: (appName, refresh) => backend.GetGameSize(appName, refresh),
});

/** Fires when a size arrives, so whatever is showing it can repaint. */
export const subscribe = cache.subscribe;

/** The size of a game, if we already have it. Never blocks and never fetches. */
export const get = cache.get;

/** Make sure we're getting this game's size. Safe to call every render. */
export const ensure = cache.ensure;

/**
 * Drop a game's size here and in the backend, whose cache can't tell a new build
 * shipped. state/jobs.ts calls this when a job finishes.
 */
export const forget = cache.invalidate;
