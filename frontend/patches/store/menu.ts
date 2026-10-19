import { findModuleExport, MenuItem, type MenuGroupProps } from "millennium";
import {
  cloneElement,
  createElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { EPIC_STORE, open } from "../../services/epic/store";

// Splits the Store menu into a Steam Store submenu, holding Steam's own entries, and an
// Epic Games Store one, whose entries open Epic's store in the main window browser the
// way Steam's open its own. backend/patches.lua hands us each supernav menu as Steam
// creates it, through `SupernavMenu`

const STEAM_STORE = "https://store.steampowered.com/";

// Steam's own name for the menu's popup, not shown and so not localised
const MENU_TITLE = "Store Supernav";

// Locale-free paths, as Epic redirects to the visitor's language itself
const ENTRIES = [
  { label: "Store", path: "/" },
  { label: "New Releases", path: "/browse?sortBy=releaseDate&sortDir=DESC&category=Game" },
  { label: "Free Games", path: "/free-games" },
  {
    label: "Sales",
    path: "/browse?sortBy=relevancy&sortDir=DESC&priceTier=tierDiscouted&category=Game",
  },
  { label: "News", path: "/news" },
  { label: "Wishlist", path: "/wishlist" },
] as const;

interface MenuProps {
  menuItems?: unknown[];
  disabledItemClass?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children?: unknown;
}

// Steam's renderer for supernav entries, to draw its own in the submenu unchanged
type MenuItems = ComponentType<{ menuItems: unknown[]; disabledItemClass?: string }>;

interface MenuInstance {
  ForceHide(): void;
  // Closes the open submenu, which is its own popup and outlives the menu otherwise
  InternalHideSubMenu?(): void;
}

// Steam's submenu row, a small wrapper handing its class `bInGamepadUI`; Millennium's
// own `MenuGroup` is undefined on current builds
const MenuGroup = findModuleExport((value) => {
  const source = typeof value === "function" ? String(value) : "";
  return source.length < 200 && /\{\.\.\.[\w$]+,bInGamepadUI:/.test(source);
}) as ComponentType<MenuGroupProps & { onClick?: () => void }> | undefined;
if (!MenuGroup) console.warn("Steam's submenu component wasn't found, so Store isn't split");

export function SupernavMenu(
  menu: ReactElement<MenuProps>,
  title: string,
  instance: RefObject<MenuInstance | undefined>,
  getMenuItems: () => MenuItems,
) {
  if (title !== MENU_TITLE || !MenuGroup) return menu;

  // A submenu is its own popup, so entering it leaves the menu, which then hides itself
  // and the submenu with it; Steam's handlers count it as part of the menu
  const { onMouseEnter, onMouseLeave } = menu.props;
  const hover = (children: ReactNode) =>
    createElement("div", { style: { display: "contents" }, onMouseEnter, onMouseLeave }, children);

  // A row goes where its store's front page is when clicked, as Store itself does
  const group = (label: string, url: string, children: ReactNode) =>
    createElement(
      MenuGroup,
      {
        key: label,
        label,
        onClick: () => {
          instance.current?.InternalHideSubMenu?.();
          instance.current?.ForceHide();
          open(url);
        },
      },
      hover(children),
    );

  const steam = group(
    "Steam Store",
    STEAM_STORE,
    createElement(getMenuItems(), {
      menuItems: menu.props.menuItems ?? [],
      disabledItemClass: menu.props.disabledItemClass,
    }),
  );

  const epic = group(
    "Epic Games Store",
    `${EPIC_STORE}/`,
    ENTRIES.map(({ label, path }) =>
      createElement(MenuItem, { key: path, onSelected: () => open(EPIC_STORE + path) }, label),
    ),
  );

  return cloneElement(menu, { menuItems: [], children: [steam, epic] });
}
