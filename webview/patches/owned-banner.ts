// Marks Steam game pages for games in the Epic library with Steam's own "already
// owned" bar

const BANNER_ID = "epic-games-owned";

// Letters and digits only, since store titles mostly differ in punctuation; roman
// numerals and "the" are left alone to avoid matching different games
function normalize(title: string) {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

// Editions Epic and Steam disagree about for what is otherwise one game
const EDITION =
  /(definitive|deluxe|enhanced|complete|goty|gameoftheyear|remastered|ultimate|standard)?edition$/;

function keys(title: string) {
  const base = normalize(title);
  const stripped = base.replace(EDITION, "");
  return stripped && stripped !== base ? [base, stripped] : [base];
}

function storeTitle() {
  const heading = document.querySelector("#appHubAppName, .apphub_AppName");
  const text = heading?.textContent?.trim();
  if (text) return text;

  const meta = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
  return meta?.content?.trim() || undefined;
}

// Restates enough of Steam's styling to survive moved classes, and recolours the flag
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
  // Epic's title, so a match on a stripped edition name is visible as one
  name.textContent = game.title;

  text.append(
    name,
    ` is already in your Epic Games library${game.installed ? ", and installed" : ""}.`,
  );

  const flag = document.createElement("div");
  flag.className = `ds_owned_flag ds_flag ${BANNER_ID}-flag`;
  flag.textContent = "In Epic library";

  banner.append(text, flag);

  // Above the purchase area, with the rest as fallbacks for other layouts
  const target =
    document.querySelector("#game_area_purchase") ??
    document.querySelector(".game_page_autocollapse") ??
    document.querySelector(".page_content .rightcol");

  if (!target?.parentElement) return;

  target.parentElement.insertBefore(style, target);
  target.parentElement.insertBefore(banner, target);
}

export async function markOwned() {
  const title = storeTitle();
  if (!title) return;

  // The backend's cache, as this runs on every store page and asking Epic takes seconds
  const library = await backend.GetLibrary(false, false);

  const wanted = new Set(keys(title));
  // Lua sends {} for an empty list
  const owned = Object.values(library.games).find((game) =>
    keys(game.title).some((key) => wanted.has(key)),
  );

  if (!owned) return;

  console.debug("Marking a store page as owned on Epic", { title, epic: owned.title });
  render(owned);
}
