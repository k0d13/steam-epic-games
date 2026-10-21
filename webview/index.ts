import { hideLauncherDownload } from "./patches/launcher-download";
import { markOwned } from "./patches/owned-banner";

// Patches for store pages, which aren't part of the client's React tree and so get
// their own bundle; this runs on every page, so each one checks it's on its own
export default async function main() {
  const { hostname, pathname } = location;

  // Epic's store: hide the launcher download button
  if (hostname === "store.epicgames.com") {
    hideLauncherDownload();
  }

  // A Steam game page: mark it with Steam's own "already owned" bar if it's in the Epic library
  if (hostname === "store.steampowered.com" && /^\/app\/\d+/.test(pathname)) {
    await markOwned();
  }
}
