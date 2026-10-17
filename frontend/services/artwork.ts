import { ELibraryAssetType } from "millennium";
import { createStore } from "../state/storage";

// Art from Epic's catalog metadata, fetched here because Lua has no HTTP client
// and SetCustomArtworkForApp wants base64 anyway.

// Bump the version to re-apply everything, e.g. after adding an asset type.
const done = createStore<true>("epic-games:artwork-done:v1");

/** Has this game had its artwork applied? Steam keeps it, so it's done once. */
export function isDone(appName: string): boolean {
  return done.get(appName) === true;
}

export const forget = done.remove;

/** Forget every game, so the next sync downloads all of it again. */
export const forgetAll = done.clear;

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.blob();
}

/** The base64 out of a `data:` URL, which is all SetCustomArtworkForApp wants. */
const stripDataUrl = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/**
 * Fetch an image as bare base64. Given a whole `data:` URL, SetCustomArtworkForApp
 * silently writes a broken asset.
 */
async function fetchAsBase64(url: string): Promise<{ base64: string; type: "jpg" | "png" }> {
  const blob = await fetchBlob(url);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  return {
    base64: stripDataUrl(dataUrl),
    type: blob.type === "image/png" ? "png" : "jpg",
  };
}

// Steam writes Icon artwork as `<appid>.png` but shortcuts read `<appid>_icon.png`,
// so the backend renames it. Epic ships no icons, so one is cropped from box art.

/** Steam draws these at 16-32px; anything larger is bytes nobody sees. */
const ICON_SIZE = 256;

/** The 32-bit account id naming the userdata folder; only a hint for the backend. */
export function accountId(): number | undefined {
  const steamId = window.App?.m_CurrentUser?.strSteamID;
  if (!steamId) return undefined;

  try {
    // Low 32 bits; BigInt since a SteamID64 exceeds a double's precision.
    return Number(BigInt(steamId) & 0xffffffffn);
  } catch (e) {
    console.debug("Could not read the current SteamID", e);
    return undefined;
  }
}

/** Crop a square icon from artwork. Via a blob, since a cross-origin canvas is tainted. */
async function cropToIcon(url: string): Promise<string> {
  const bitmap = await createImageBitmap(await fetchBlob(url));

  try {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");

    // Centre crop, so 3:4 box art keeps its key art rather than squashing.
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      ICON_SIZE,
      ICON_SIZE,
    );

    return stripDataUrl(canvas.toDataURL("image/png"));
  } finally {
    bitmap.close();
  }
}

/** Give one shortcut an icon, and say whether that worked. */
async function applyIcon(appId: number, game: EpicGame): Promise<boolean> {
  const source = game.art_portrait ?? game.art_hero;
  if (!source) return false;

  try {
    const base64 = await cropToIcon(source);
    await SteamClient.Apps.SetCustomArtworkForApp(appId, base64, "png", ELibraryAssetType.Icon);

    const path = await backend.PlaceIcon(appId, accountId());
    if (!path) return false;

    SteamClient.Apps.SetShortcutIcon(appId, path.replaceAll("/", "\\"));
    return true;
  } catch (e) {
    console.debug("Failed to apply an icon", { appName: game.app_name, error: e });
    return false;
  }
}

/** Apply every image we have for a game and return the count; failures are per asset. */
export async function apply(appId: number, game: EpicGame) {
  // No Logo: Epic barely ships wordmarks, and Steam draws the title as text instead.
  const assets: [string | null, ELibraryAssetType][] = [
    [game.art_portrait, ELibraryAssetType.Capsule],
    [game.art_hero, ELibraryAssetType.Hero],
    // Without one the app page header is a grey placeholder.
    [game.art_hero, ELibraryAssetType.Header],
  ];

  // First: Steam writes the icon as `<appid>.png`, which would clobber a PNG header.
  let applied = (await applyIcon(appId, game)) ? 1 : 0;

  for (const [url, assetType] of assets) {
    if (!url) continue;

    try {
      const { base64, type } = await fetchAsBase64(url);
      await SteamClient.Apps.SetCustomArtworkForApp(appId, base64, type, assetType);
      applied++;
    } catch (e) {
      console.debug("Failed to apply artwork", { appName: game.app_name, assetType, error: e });
    }
  }

  // Only on a hit, so a game whose downloads all failed is retried next time.
  if (applied > 0) done.set(game.app_name, true);

  return applied;
}
