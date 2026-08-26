import rpc, { type EpicGame } from "./rpc";

/**
 * The store half of the plugin. Steam's store is a web page rather than part of
 * the client's React tree, so it gets its own bundle, loaded by Millennium into
 * every steampowered.com page and running with nothing the client half has -
 * no stores, no appid mapping, only the backend over RPC.
 *
 * All it does is say "you already own this on Epic" on a store page for a game
 * that is in the Epic library, so nobody buys a second copy. It says it the way
 * Steam says the same thing about a game you own here: the same bar in the same
 * place, wearing Steam's own `game_area_already_owned` classes so it picks up
 * the store's fonts and metrics, with only the colour of the flag to say the
 * library it means is a different one.
 */

// The client half's badge, so the store's console lines read as the same
// plugin's. Kept here rather than shared with it: the two bundles have no
// module in common, and one import would pull the client half into the store.
const BADGE = "Steam Epic Games";
const BADGE_STYLE = "background: #2a2a2a; color: white; border-radius: 2px;";
function log(write: (...args: unknown[]) => void, ...args: unknown[]) {
  write(`%c ${BADGE} %c`, BADGE_STYLE, "background: transparent;", ...args);
}
export const logger = {
  debug: (...args: unknown[]) => log(console.debug, ...args),
  info: (...args: unknown[]) => log(console.info, ...args),
  warn: (...args: unknown[]) => log(console.warn, ...args),
  error: (...args: unknown[]) => log(console.error, ...args),
};

const BANNER_ID = "epic-games-owned";

/**
 * Titles differ between the two stores in punctuation and edition wording far
 * more than in words, so both sides are flattened to letters and digits before
 * they're compared. Roman-numeral and "the" differences are left alone: they
 * are rare next to the risk of matching two different games.
 */
function normalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

/** Editions Epic and Steam disagree about for what is otherwise one game. */
const EDITION =
  /(definitive|deluxe|enhanced|complete|goty|gameoftheyear|remastered|ultimate|standard)?edition$/;

function keys(title: string): string[] {
  const base = normalize(title);
  const stripped = base.replace(EDITION, "");
  return stripped && stripped !== base ? [base, stripped] : [base];
}

/** The title of the game whose store page this is, or nothing if it isn't one. */
function storeTitle(): string | undefined {
  if (!/^\/app\/\d+/.test(location.pathname)) return undefined;

  const heading = document.querySelector("#appHubAppName, .apphub_AppName");
  const text = heading?.textContent?.trim();
  if (text) return text;

  const meta = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
  return meta?.content?.trim() || undefined;
}

// Steam's own owned bar is styled by the page. These rules only restate enough
// of it to survive a build where the classes have moved, and recolour the flag,
// which is the one thing that shouldn't look like Steam's.
const STYLE = `
  #${BANNER_ID} {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-sizing: border-box;
    margin: 0 0 6px 0;
    padding: 11px 16px;
    border-radius: 3px;
    background: linear-gradient(to right, rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.15));
    color: #c6d4df;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 14px;
    line-height: 18px;
  }
  #${BANNER_ID} .${BANNER_ID}-text { flex: 1; }
  #${BANNER_ID} .${BANNER_ID}-text b { color: #ffffff; font-weight: normal; }
  #${BANNER_ID} .${BANNER_ID}-flag {
    flex: none;
    position: static;
    padding: 3px 8px;
    border-radius: 2px;
    background: #2f3134;
    color: #ffffff;
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    white-space: nowrap;
  }
`;

function render(game: EpicGame) {
  if (document.getElementById(BANNER_ID)) return;

  const style = document.createElement("style");
  style.textContent = STYLE;

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "game_area_already_owned page_content";

  const text = document.createElement("div");
  text.className = `already_in_library ${BANNER_ID}-text`;

  const name = document.createElement("b");
  // Epic's title rather than Steam's, so a match on a stripped edition name is
  // visible as one instead of looking like the page is talking about itself.
  name.textContent = game.title;

  text.append(
    name,
    ` is already in your Epic Games library${game.installed ? ", and installed" : ""}.`,
  );

  const flag = document.createElement("div");
  flag.className = `ds_owned_flag ds_flag ${BANNER_ID}-flag`;
  flag.textContent = "In Epic library";

  banner.append(text, flag);

  // Above the purchase area, which is what someone is about to click. Anything
  // else on the page is a fallback for a layout that doesn't have one.
  const target =
    document.querySelector("#game_area_purchase") ??
    document.querySelector(".game_page_autocollapse") ??
    document.querySelector(".page_content .rightcol");

  if (!target?.parentElement) return;

  target.parentElement.insertBefore(style, target);
  target.parentElement.insertBefore(banner, target);
}

export default async function WebkitMain() {
  const title = storeTitle();
  if (!title) return;

  let library;
  try {
    library = await rpc.GetLibrary();
  } catch (error) {
    logger.error("Failed to read the Epic library", error);
    return;
  }

  if (!library.ok) {
    logger.debug("The store has no library to check against", library.error);
    return;
  }

  const wanted = new Set(keys(title));
  const owned = library.games.find((game) => keys(game.title).some((key) => wanted.has(key)));

  if (!owned) return;

  logger.debug("Marking a store page as owned on Epic", { title, epic: owned.title });
  render(owned);
}
