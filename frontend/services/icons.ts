import { ELibraryAssetType } from "@steambrew/client";
import { logger } from "../index";
import rpc, { type EpicGame } from "../rpc";

// The sidebar icon is the one piece of artwork that isn't just another
// SetCustomArtworkForApp call: a shortcut's icon comes from a path in
// shortcuts.vdf pointing at `<grid>/<appid>_icon.png`, and applying artwork of
// type Icon writes `<grid>/<appid>.png` - right bytes, wrong name. So Steam
// writes them, the backend renames, and SetShortcutIcon points at the result.
// Epic ships no icon art, hence cutting one out of the box art.

/** Steam draws these at 16-32px; anything larger is bytes nobody sees. */
const ICON_SIZE = 256;

/**
 * The 32-bit account id, which names the userdata folder. A hint only - the
 * backend can find that folder itself on a single-account machine.
 */
function accountId(): number | undefined {
  const steamId = window.App?.m_CurrentUser?.strSteamID;
  if (!steamId) return undefined;

  try {
    // Low 32 bits of the SteamID64. BigInt because the full id is past what a
    // double holds exactly, and being off by one points at no folder at all.
    return Number(BigInt(steamId) & 0xffffffffn);
  } catch (e) {
    logger.debug("Could not read the current SteamID", e);
    return undefined;
  }
}

/**
 * Cut a square icon out of a piece of artwork. Drawn from a blob, since a canvas
 * holding a cross-origin image is tainted and toDataURL on it throws.
 */
async function cropToIcon(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const bitmap = await createImageBitmap(await response.blob());

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

    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally {
    bitmap.close();
  }
}

/** Give one shortcut an icon, and say whether that worked. */
export async function apply(appId: number, game: EpicGame): Promise<boolean> {
  const source = game.artPortrait ?? game.artHero;
  if (!source) return false;

  try {
    const base64 = await cropToIcon(source);
    await SteamClient.Apps.SetCustomArtworkForApp(appId, base64, "png", ELibraryAssetType.Icon);

    const path = await rpc.PlaceIcon(appId, accountId());
    if (!path) return false;

    SteamClient.Apps.SetShortcutIcon(appId, path.replaceAll("/", "\\"));
    return true;
  } catch (e) {
    logger.debug("Failed to apply an icon", { appName: game.appName, error: e });
    return false;
  }
}
