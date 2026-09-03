import { type SteamAppOverview } from "@steambrew/client";
import { logger } from "../index";
import { mainPopup, onPopupCreate } from "../services/popups";
import * as library from "../state/library";

// A little Epic mark on the artwork in the library, so an Epic game is tellable
// from a Steam one at a glance: on the list's icons, and on the grid capsules
// the collection views and the home shelves are built from.
//
// Steam puts no appid in that DOM and neither of the components that could add
// one can be patched: the icon component is a webpack export behind a
// non-configurable getter, and the row above it is a mobx class whose `render`
// replaces itself with a non-writable one on the instance the first time it
// runs. So the appid is read back off the React fiber instead and written onto
// the artwork as an attribute, which leaves the badge itself pure CSS - nothing
// here has to change to move it, resize it or redraw it.

/** Everything about how the badge looks, in one place. */
const BADGE = {
  /** Share of the icon's width. Steam draws those at around 24px. */
  iconSize: "55%",
  /** How far the icon's badge hangs off its bottom-right corner. */
  overhang: "2px",
  /** Capsules dwarf icons, so theirs is a fixed size sitting inside the art. */
  capsuleSize: "26px",
  capsuleInset: "6px",
  radius: "20%",
  background: "#2a2a2a",
  /** Epic's shield, drawn rather than fetched: no network on the render path. */
  logo:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E" +
    "%3Cpath fill='%23fff' d='M5.5 2h13a1.5 1.5 0 0 1 1.5 1.5v10.2c0 .5-.2.9-.6 1.2l-6.6 5.4a1.5 1.5 0 0 1-1.9 0L4.6 15a1.5 1.5 0 0 1-.6-1.2V3.5A1.5 1.5 0 0 1 5.5 2Z'/%3E" +
    "%3Cpath fill='%232a2a2a' d='M9 6h6v1.6h-4.2v2H14v1.6h-3.2v2.2H15V15H9Z'/%3E%3C/svg%3E",
  /** Share of the badge the logo fills, leaving it a margin. */
  logoScale: "78%",
} as const;

const ATTRIBUTE = "data-epic-game";
const STYLE_ID = "epic-games-badge";

const CSS = `
[${ATTRIBUTE}] {
  position: relative;
  overflow: visible;
}

[${ATTRIBUTE}]::after {
  content: "";
  position: absolute;
  border-radius: ${BADGE.radius};
  background: ${BADGE.background} url("${BADGE.logo}") center / ${BADGE.logoScale} no-repeat;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

[${ATTRIBUTE}="icon"]::after {
  right: -${BADGE.overhang};
  bottom: -${BADGE.overhang};
  width: ${BADGE.iconSize};
  height: ${BADGE.iconSize};
}

[${ATTRIBUTE}="capsule"]::after {
  right: ${BADGE.capsuleInset};
  bottom: ${BADGE.capsuleInset};
  width: ${BADGE.capsuleSize};
  height: ${BADGE.capsuleSize};
}
`;

/**
 * What Steam draws a game's artwork into, and which shape of badge each takes.
 * Hashed class names sit beside readable ones, and these cover the library
 * whole: `GameIcon` is the list's icon and `Capsule` every grid tile, in the
 * collection views and on the home shelves alike. Home's recent-game cards are
 * a `FeaturedCapsule` instead, which is the whole card, footer included - so
 * the badge goes on its artwork child, where it lands in the same corner of the
 * art as everywhere else rather than down in the footer.
 */
const TARGETS = {
  '[class~="GameIcon"]': "icon",
  '[class~="Capsule"]': "capsule",
  '[class~="FeaturedCapsule"] > [class~="Container"]': "capsule",
} as const;

interface Fiber {
  memoizedProps: Record<string, unknown> | null;
  return: Fiber | null;
}

function getFiber(node: Element): Fiber | undefined {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$")) return Reflect.get(node, key) as Fiber;
  }
  return undefined;
}

/**
 * The appid the artwork is drawn for. Its own fiber doesn't carry one - it's on
 * components above it, which hold the app either as `appid`, as an overview
 * under `app`, or as the list entry's `item`.
 */
function findAppId(element: Element): number | undefined {
  for (let fiber: Fiber | null | undefined = getFiber(element); fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props) continue;

    for (const value of [
      props.appid,
      (props.app as SteamAppOverview)?.appid,
      (props.item as SteamAppOverview)?.appid,
    ]) {
      if (typeof value === "number") return value;
    }
  }

  return undefined;
}

/** Mark, or unmark, every piece of artwork under `root`. */
function stamp(root: Element) {
  // Nothing signed in means nothing can match, and the observer sees every
  // mutation in the window - a theme loading is thousands of them.
  if (library.isEmpty()) {
    for (const element of root.querySelectorAll(`[${ATTRIBUTE}]`)) {
      element.removeAttribute(ATTRIBUTE);
    }
    return;
  }

  for (const [selector, kind] of Object.entries(TARGETS)) {
    for (const element of root.querySelectorAll(selector)) {
      const appId = findAppId(element);
      // Removed as well as added: the library recycles its rows and its tiles,
      // so artwork that was ours a scroll ago is drawn for a Steam game now.
      if (appId !== undefined && library.getByAppId(appId)) element.setAttribute(ATTRIBUTE, kind);
      else element.removeAttribute(ATTRIBUTE);
    }
  }
}

function addStyle(document: Document) {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Watch one window: its artwork now, and again whenever the library changes.
 * Both kinds of change matter - scrolling adds rows and tiles, and a recycled
 * one only has its image swapped.
 */
function watch(root: Element | undefined) {
  if (!root?.ownerDocument) return undefined;

  addStyle(root.ownerDocument);

  // Coalesced, since one scroll is a burst of records and stamping reads
  // layout-free fiber props for every piece of artwork on screen.
  let queued = false;
  const restamp = () => {
    if (queued) return;
    queued = true;
    root.ownerDocument.defaultView?.requestAnimationFrame(() => {
      queued = false;
      stamp(root);
    });
  };

  const observer = new MutationObserver(restamp);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });

  stamp(root);

  return { disconnect: () => observer.disconnect(), restamp };
}

export function register() {
  const watchers = new Set<{ disconnect(): void; restamp(): void }>();

  const add = (root: Element | undefined) => {
    const watcher = watch(root);
    if (watcher) watchers.add(watcher);
    return watcher;
  };

  add(mainPopup()?.root_element);

  // The library lives in the desktop window, but a detached one is a popup of
  // its own, so every window gets the same treatment.
  const unwatch = onPopupCreate((popup, handlers) => {
    const watcher = add(popup.root_element);
    if (!watcher) return;

    handlers.onOpen(() => watcher.restamp());
    handlers.onClose(() => {
      watcher.disconnect();
      watchers.delete(watcher);
    });
  });

  // A game that's just been synced has artwork on screen already, drawn before
  // we knew the appid was ours.
  const unsubscribe = library.subscribe(() => {
    for (const watcher of watchers) watcher.restamp();
  });

  logger.debug("Registered the library badge patch");

  return () => {
    unwatch();
    unsubscribe();
    for (const watcher of watchers) watcher.disconnect();
  };
}
