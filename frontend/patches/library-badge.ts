import { type SteamAppOverview } from "millennium";
import { findUp } from "../services/fiber";
import { onPopupCreate } from "../services/popups";
import * as library from "../state/library";

// An Epic mark on library artwork. The components can't be patched, so the appid is
// read off the React fiber and set as an attribute, leaving the badge pure CSS.

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
 * Artwork containers and their badge shape. A `FeaturedCapsule` is the whole card,
 * so the badge goes on its art child rather than in the footer.
 */
const TARGETS = {
  '[class~="GameIcon"]': "icon",
  '[class~="Capsule"]': "capsule",
  '[class~="FeaturedCapsule"] > [class~="Container"]': "capsule",
} as const;

/** The artwork's appid, held above it as `appid`, `app` (an overview) or `item`. */
function findAppId(element: Element): number | undefined {
  return findUp(element, ({ memoizedProps: props }) => {
    if (!props) return undefined;

    for (const value of [
      props.appid,
      (props.app as SteamAppOverview | undefined)?.appid,
      (props.item as SteamAppOverview | undefined)?.appid,
    ]) {
      if (typeof value === "number") return value;
    }
    return undefined;
  });
}

/** Mark, or unmark, every piece of artwork under `root`. */
function stamp(root: Element) {
  // Nothing can match, and a theme loading is thousands of mutations.
  if (library.isEmpty()) {
    for (const element of root.querySelectorAll(`[${ATTRIBUTE}]`)) {
      element.removeAttribute(ATTRIBUTE);
    }
    return;
  }

  for (const [selector, kind] of Object.entries(TARGETS)) {
    for (const element of root.querySelectorAll(selector)) {
      const appId = findAppId(element);
      // Removed too: the library recycles tiles, so ours may now show a Steam game.
      if (appId !== undefined && library.getByAppId(appId)) element.setAttribute(ATTRIBUTE, kind);
      else element.removeAttribute(ATTRIBUTE);
    }
  }
}

/** Watch one window's artwork; scrolling adds tiles and recycling only swaps `src`. */
function watch(root: Element | undefined) {
  if (!root?.ownerDocument) return undefined;

  const document = root.ownerDocument;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // Coalesced, since one scroll is a burst of records.
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

  // The main window, and a detached library window, which is a popup of its own.
  const unwatch = onPopupCreate((popup) => {
    const watcher = watch(popup.root_element);
    if (!watcher) return;
    watchers.add(watcher);

    return () => {
      watcher.disconnect();
      watchers.delete(watcher);
    };
  });

  // Newly synced games already have artwork on screen.
  const unsubscribe = library.subscribe(() => {
    for (const watcher of watchers) watcher.restamp();
  });

  console.debug("Registered the library badge patch");

  return () => {
    unwatch();
    unsubscribe();
    for (const watcher of watchers) watcher.disconnect();
  };
}
