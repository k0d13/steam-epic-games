import { ELibraryAssetType } from "@steambrew/client";
import { logger } from "../index";
import { type EpicGame } from "../rpc";
import { createStore } from "../state/storage";
import * as icons from "./icons";

// Artwork comes from Epic's own catalog metadata, which ships a tall box art and
// a wide capsule for essentially every title - so there's no SteamGridDB key to
// configure and no scraping. The bytes are fetched here in the client rather
// than in the backend because Millennium's Lua has no HTTP client, and because
// SetCustomArtworkForApp wants base64 anyway.

// Bumping the version means "what we apply has changed, do it all again", which
// is how an existing library picks up an asset that didn't used to be set.
const done = createStore<true>("epic-games:artwork-done:v1");

/**
 * Has this game had its artwork applied? Tracked because it's the expensive part
 * of a sync - four downloads per game - and Steam keeps what it's given in its
 * own grid folder, so it only ever needs doing once.
 */
export function isDone(appName: string): boolean {
  return done.get(appName) === true;
}

export const forget = done.remove;

/** Forget every game, so the next sync downloads all of it again. */
export const forgetAll = done.clear;

/**
 * Fetch an image and hand it back as bare base64.
 *
 * FileReader gives us a `data:` URL, and SetCustomArtworkForApp wants only the
 * payload after the comma - passing the whole URL through silently produces a
 * broken asset rather than an error, which is a miserable thing to debug.
 */
async function fetchAsBase64(url: string): Promise<{ base64: string; type: "jpg" | "png" }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  return {
    base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    type: blob.type === "image/png" ? "png" : "jpg",
  };
}

/**
 * Apply every image we have for one game, and say how many that came to.
 * Failures are swallowed per asset - a hero image Epic 404s on shouldn't stop
 * the box art being applied.
 */
export async function apply(appId: number, game: EpicGame) {
  // No Logo: Steam's is the transparent wordmark over the hero image, and Epic
  // barely ships one. Steam draws the title as text instead, which is what
  // everyone was always going to get.
  const assets: [string | undefined, ELibraryAssetType][] = [
    [game.artPortrait, ELibraryAssetType.Capsule],
    [game.artHero, ELibraryAssetType.Hero],
    // Steam's wide header is the same shape as Epic's wide capsule, and without
    // one the app page header falls back to a grey placeholder.
    [game.artHero, ELibraryAssetType.Header],
  ];

  // Before the rest: Steam writes the icon as `<appid>.png`, which is the
  // header's stem, so a hero image that came back as a PNG would rename the
  // header out from under itself if this ran last.
  let applied = (await icons.apply(appId, game)) ? 1 : 0;

  for (const [url, assetType] of assets) {
    if (!url) continue;

    try {
      const { base64, type } = await fetchAsBase64(url);
      await SteamClient.Apps.SetCustomArtworkForApp(appId, base64, type, assetType);
      applied++;
    } catch (e) {
      logger.debug("Failed to apply artwork", { appName: game.appName, assetType, error: e });
    }
  }

  // Only on a hit: a game whose downloads all failed - offline, or Epic having a
  // bad day - should be retried next time rather than written off for good.
  if (applied > 0) done.set(game.appName, true);

  return applied;
}
