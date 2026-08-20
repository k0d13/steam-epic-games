import { ELibraryAssetType } from "@steambrew/client";
import { logger } from "../index";
import { type EpicGame } from "../rpc";
import { createStore } from "../state/storage";
import * as icons from "./icons";

// Artwork comes from Epic's own catalog metadata, which has a tall box art and
// a wide capsule for nearly every title - no SteamGridDB key, no scraping. The
// bytes are fetched here rather than in the backend because Lua has no HTTP
// client, and SetCustomArtworkForApp wants base64 anyway.

// Bumping the version re-applies everything, which is how an existing library
// picks up an asset we didn't used to set.
const done = createStore<true>("epic-games:artwork-done:v1");

/**
 * Has this game had its artwork applied? Tracked because it's four downloads a
 * game, and Steam keeps what it's given - so it only needs doing once.
 */
export function isDone(appName: string): boolean {
  return done.get(appName) === true;
}

export const forget = done.remove;

/** Forget every game, so the next sync downloads all of it again. */
export const forgetAll = done.clear;

/**
 * Fetch an image and hand it back as bare base64. SetCustomArtworkForApp wants
 * only the payload after the comma; give it the whole `data:` URL and it writes
 * a broken asset without complaining.
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
  // No Logo: that's the transparent wordmark over the hero image, which Epic
  // barely ships. Steam draws the title as text without one.
  const assets: [string | undefined, ELibraryAssetType][] = [
    [game.artPortrait, ELibraryAssetType.Capsule],
    [game.artHero, ELibraryAssetType.Hero],
    // Same shape as Epic's wide capsule, and without one the app page header
    // is a grey placeholder.
    [game.artHero, ELibraryAssetType.Header],
  ];

  // Before the rest: Steam writes the icon as `<appid>.png`, the same stem a
  // PNG header would take, so running this last can clobber the header.
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

  // Only on a hit, so a game whose downloads all failed is retried next time.
  if (applied > 0) done.set(game.appName, true);

  return applied;
}
