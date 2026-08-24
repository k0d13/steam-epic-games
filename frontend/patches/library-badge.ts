import { Steam } from "steambrew-utils";
import { onPopupCreate } from "steambrew-utils/watchers";
import { logger } from "../index";
import * as library from "../state/library";

// A little Epic mark on the icons in the library list, so an Epic game is
// tellable from a Steam one at a glance.
//
// Steam puts no appid in that list's DOM and neither of the components that
// could add one can be patched: the icon component is a webpack export behind a
// non-configurable getter, and the row above it is a mobx class whose `render`
// replaces itself with a non-writable one on the instance the first time it
// runs. So the appid is read back off the React fiber instead and written onto
// the icon as an attribute, which leaves the badge itself pure CSS - nothing
// here has to change to move it, resize it or redraw it.

/** Everything about how the badge looks, in one place. */
const BADGE = {
  /** Share of the icon's width. Steam draws these at around 24px. */
  size: "55%",
  /** How far the badge hangs off the icon's bottom-right corner. */
  overhang: "2px",
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
  right: -${BADGE.overhang};
  bottom: -${BADGE.overhang};
  width: ${BADGE.size};
  height: ${BADGE.size};
  border-radius: ${BADGE.radius};
  background: ${BADGE.background} url("${BADGE.logo}") center / ${BADGE.logoScale} no-repeat;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
`;

/**
 * The class Steam gives the icon in the library list. Hashed class names sit
 * beside readable ones, and only the list icon carries this one - the grid's
 * capsules are a different component.
 */
const ICON_SELECTOR = '[class~="GameIcon"]';

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
 * The appid the icon is drawn for. The icon's own fiber doesn't carry one -
 * it's on components above it, which hold the app either as `appid`, as an
 * overview under `app`, or as the list entry's `item`.
 */
function findAppId(icon: Element): number | undefined {
  for (let fiber: Fiber | null | undefined = getFiber(icon); fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props) continue;

    for (const value of [
      props.appid,
      (props.app as Steam.AppOverview)?.appid,
      (props.item as Steam.AppOverview)?.appid,
    ]) {
      if (typeof value === "number") return value;
    }
  }

  return undefined;
}

/** Mark, or unmark, every icon under `root`. */
function stamp(root: Element) {
  for (const icon of root.querySelectorAll(ICON_SELECTOR)) {
    const appId = findAppId(icon);
    // Removed as well as added: the list recycles its rows, so an icon that
    // was ours a scroll ago is drawn for a Steam game now.
    if (appId !== undefined && library.getByAppId(appId)) icon.setAttribute(ATTRIBUTE, "");
    else icon.removeAttribute(ATTRIBUTE);
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
 * Watch one window: its icons now, and again whenever the list changes. Both
 * kinds of change matter - scrolling adds rows, and a recycled row only has its
 * image swapped.
 */
function watch(root: Element | undefined) {
  if (!root?.ownerDocument) return undefined;

  addStyle(root.ownerDocument);

  // Coalesced, since one scroll is a burst of records and stamping reads
  // layout-free fiber props for every icon in the list.
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

  add(Steam.MainPopup?.root_element);

  // The library lives in the desktop window, but a detached one is a popup of
  // its own, so every window gets the same treatment.
  const unwatch = onPopupCreate((popup, _type, handlers) => {
    const watcher = add(popup.root_element);
    if (!watcher) return;

    handlers.onOpen(() => watcher.restamp());
    handlers.onClose(() => {
      watcher.disconnect();
      watchers.delete(watcher);
    });
  });

  // A game that's just been synced has an icon on screen already, drawn before
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
