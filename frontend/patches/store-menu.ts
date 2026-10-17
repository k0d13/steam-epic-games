import { MenuItem, type MenuGroupProps } from "millennium";
import {
  createElement,
  cloneElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { findUp } from "../services/fiber";
import { findExport } from "../services/modules";
import { memo } from "../services/once";

// Splits the Store menu into a Steam Store submenu, holding Steam's own entries, and
// an Epic Games Store one, whose entries open Epic's store in the main window browser
// the way Steam's open its own.

const EPIC = "https://store.epicgames.com";
const STEAM = "https://store.steampowered.com/";

/** Steam's own name for the menu's popup, not shown and so not localised. */
const MENU_TITLE = "Store Supernav";

/** Locale-free paths: Epic redirects to the visitor's language itself. */
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

/** Hosts that count as the store: Epic's storefront, its sign in and its checkout. */
function isEpicURL(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "epicgames.com" || hostname.endsWith(".epicgames.com");
  } catch {
    return false;
  }
}

interface BrowserManager {
  GetTabForURL(url: string): string;
  ShowURL(url: string): void;
}

function manager(): BrowserManager | undefined {
  return window.MainWindowBrowserManager as BrowserManager | undefined;
}

/**
 * Epic's URLs would otherwise "maintain" whichever tab was last, leaving Community
 * lit over Epic's store. The instance is created with the main window, which can be
 * after the plugin loads, so this is retried on every open.
 */
let restoreTabs: (() => void) | undefined;

function patchManager(browser: BrowserManager) {
  if (restoreTabs) return;

  const original = browser.GetTabForURL;
  browser.GetTabForURL = function (url) {
    return isEpicURL(url) ? "store" : original.call(this, url);
  };
  restoreTabs = () => {
    browser.GetTabForURL = original;
  };
}

function open(url: string) {
  const browser = manager();
  if (!browser) {
    console.warn("The main window browser isn't there to open the store in");
    return;
  }
  patchManager(browser);
  browser.ShowURL(url);
}

/** What a supernav's menu element is drawn from. */
interface MenuProps {
  menuItems?: unknown[];
  disabledItemClass?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children?: unknown;
}

/** Steam's renderer for supernav entries, to draw its own in the submenu unchanged. */
type MenuItems = ComponentType<{ menuItems: unknown[]; disabledItemClass?: string }>;

const getMenuItems = memo(() => {
  const component = findExport("bSuperNavBehavior", (value): value is MenuItems => {
    if (typeof value !== "function") return false;
    const source = value.toString();
    return (
      source.includes("disabledItemClass") &&
      source.includes("menuItems") &&
      !source.includes("refContextMenu") &&
      !source.includes("bSuperNavBehavior")
    );
  });
  if (!component) console.warn("Steam's supernav entries weren't found");
  return component;
});

/** Steam's submenu row. Millennium's own `MenuGroup` is undefined on current builds. */
type MenuGroup = ComponentType<MenuGroupProps>;

/** The small wrapper that hands the row's class `bInGamepadUI`. */
const getMenuGroup = memo(() => {
  const component = findExport("RenderSubMenu", (value): value is MenuGroup => {
    if (typeof value !== "function") return false;
    const source = value.toString();
    return source.includes("bInGamepadUI:") && source.length < 200;
  });
  if (!component) console.warn("Steam's submenu component wasn't found");
  return component;
});

/** Marks a submenu's row with the store it opens, for the click handler in `register`. */
const STORE_ATTRIBUTE = "data-epic-store-row";

/** Where each submenu's row goes when it's clicked, as Store itself does. */
const ROW_URLS: Record<string, string> = { steam: STEAM, epic: `${EPIC}/` };

function groupLabel(text: string, store: keyof typeof ROW_URLS): string {
  const label = createElement("span", { [STORE_ATTRIBUTE]: store }, text);
  // MenuGroup's label is drawn as a child, so an element works where its type says string.
  return label as unknown as string;
}

function buildMenu(original: ReactElement<MenuProps>): ReactElement<MenuProps> | undefined {
  const MenuItems = getMenuItems();
  const MenuGroup = getMenuGroup();
  if (!MenuItems || !MenuGroup) return undefined;

  // A submenu is its own popup, so entering it leaves the menu, which then hides
  // itself and the submenu with it. Steam's handlers count it as part of the menu.
  const { onMouseEnter, onMouseLeave } = original.props;
  const hover = (children: ReactNode) =>
    createElement("div", { style: { display: "contents" }, onMouseEnter, onMouseLeave }, children);

  const steam = createElement(
    MenuGroup,
    {
      key: "steam",
      label: groupLabel("Steam Store", "steam"),
    },
    hover(
      createElement(MenuItems, {
        menuItems: original.props.menuItems ?? [],
        disabledItemClass: original.props.disabledItemClass,
      }),
    ),
  );

  const epic = createElement(
    MenuGroup,
    {
      key: "epic",
      label: groupLabel("Epic Games Store", "epic"),
    },
    hover(
      ENTRIES.map(({ label, path }) =>
        createElement(MenuItem, { key: path, onSelected: () => open(EPIC + path) }, label),
      ),
    ),
  );

  return cloneElement(original, { menuItems: [], children: [steam, epic] });
}

interface MenuInstance {
  m_rctElement: ReactElement<MenuProps>;
  ForceHide(): void;
  /** Closes the open submenu, which is its own popup and outlives the menu otherwise. */
  InternalHideSubMenu?(): void;
}

/** The menu's controller, which only its React props reach. Kept with the popup. */
function findInstance(document: Document): MenuInstance | undefined {
  const element = document.querySelector(".contextMenu");
  if (!element) return undefined;

  return findUp(element, (fiber) => {
    const instance = fiber.memoizedProps?.instance as MenuInstance | undefined;
    return instance?.m_rctElement ? instance : undefined;
  });
}

export function register(): () => void {
  const popups = g_PopupManager;
  if (!popups) return () => {};

  let restoreMenu: (() => void) | undefined;
  let observer: MutationObserver | undefined;

  // The element is read on each show, so swapping it redraws the menu next time.
  function patchMenu(document: Document) {
    const instance = findInstance(document);
    if (!instance || restoreMenu) return;

    const original = instance.m_rctElement;
    const menu = buildMenu(original);
    if (!menu) return;

    // On the whole row, not the label, which leaves the row's padding dead.
    const onClick = (event: MouseEvent) => {
      const row = (event.target as Element | null)?.closest(".contextMenuItem");
      const store = row?.querySelector(`[${STORE_ATTRIBUTE}]`)?.getAttribute(STORE_ATTRIBUTE);
      const url = store && ROW_URLS[store];
      if (!url) return;

      event.stopPropagation();
      instance.InternalHideSubMenu?.();
      instance.ForceHide();
      open(url);
    };
    document.addEventListener("click", onClick, true);

    instance.m_rctElement = menu;
    restoreMenu = () => {
      instance.m_rctElement = original;
      document.removeEventListener("click", onClick, true);
    };
    observer?.disconnect();
    console.debug("Split the Store menu into Steam and Epic");
  }

  // The popup is made with the main window and kept; it may not have drawn yet.
  function watch(popup: SteamPopup) {
    const document = popup.window?.document;
    if (popup.m_strTitle !== MENU_TITLE || !document?.body || restoreMenu) return;

    patchMenu(document);
    if (restoreMenu) return;
    observer = new MutationObserver(() => patchMenu(document));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  for (const popup of popups.m_mapPopups?.values() ?? []) watch(popup);
  const { Unregister } = popups.AddPopupCreatedCallback(watch);

  // Also here, so an Epic link followed before the menu was ever used lights Store.
  const browser = manager();
  if (browser) patchManager(browser);

  console.debug("Registered the store menu patch");
  return () => {
    Unregister();
    observer?.disconnect();
    restoreMenu?.();
    restoreTabs?.();
    restoreTabs = undefined;
  };
}
