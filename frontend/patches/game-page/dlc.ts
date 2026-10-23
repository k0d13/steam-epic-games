import { type AppDetails, callOriginal, replacePatch } from "millennium";
import { open, searchURL } from "../../services/epic/store";
import * as info from "../../state/game/info";
import * as jobs from "../../state/jobs";
import * as library from "../../state/library";

// Steam draws the game page's DLC section and the properties DLC tab from `vecDLC`, and
// its checkboxes call SetDLCEnabled; backend/patches.lua adds the tab and ShortcutSections
// the section, both for a shortcut, and has `SteamURL` answer the links to the store

// Steam's DLC have appids of their own, which ours get from a hash of Epic's name, in the
// range between Steam's appids and its shortcuts'
function dlcAppId(appName: string) {
  let hash = 0x811c9dc5;
  for (const char of appName) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return 0x40000000 | (hash & 0x3fffffff);
}

function storeURL(game: EpicGame) {
  const page = Object.values(info.get(game.app_name)?.links ?? []).find(
    (link) => link.label === "Store Page",
  );
  return page ? page.url.replace("/p/", "/all-dlc/") : searchURL(game.title);
}

// For library/app-details
export function applyDlc(details: AppDetails, game: EpicGame) {
  const job = jobs.get(game.app_name);

  details.vecDLC = game.dlcs.map((dlc) => ({
    unAppID: dlcAppId(dlc.app_name),
    strName: dlc.title,
    rtPurchaseDate: dlc.purchased_at ?? 0,
    strState: dlc.installed ? "installed" : "notinstalled",
    // Checked from the moment it's asked for, as Steam's is
    bEnabled: dlc.installed || (job?.target === dlc.app_name && jobs.isBusy(job)),
    bAvailableOnStore: false,
    strHeaderFilename: "",
    rtStoreAssetModifyType: 0,
    lDiskUsageBytes: dlc.install_size ?? 0,
  }));
}

// Steam's "View DLC In Store" sends the window to steam://url/StoreDlcPage/<appid>, so
// the page opens in the store here, and the window is sent nowhere
export function SteamURL(name: string, values: unknown[]) {
  const game = name === "StoreDlcPage" ? library.getByAppId(Number(values[0])) : undefined;
  if (!game) return undefined;

  open(storeURL(game));
  return "javascript:void(0)";
}

export function register() {
  return replacePatch(SteamClient.Apps, "SetDLCEnabled", ([appId, dlcId, enabled]) => {
    const game = library.getByAppId(appId);
    const dlc = game?.dlcs.find((candidate) => dlcAppId(candidate.app_name) === dlcId);
    if (!game || !dlc) return callOriginal;

    if (enabled) void jobs.installDlc(game.app_name, dlc.app_name);
    else void jobs.uninstallDlc(game.app_name, dlc.app_name);
    return Promise.resolve();
  }).unpatch;
}
