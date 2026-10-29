import {
  createElement,
  Fragment,
  type ReactNode,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import * as library from "../../state/library";
import { isEpicPersona } from "../game-page/friends";

// An Epic mark on library artwork; backend/patches.lua has Steam's artwork component,
// which draws every icon and capsule, ask `LibraryBadge` for one, and its avatar
// component `FriendBadge` for an Epic friend's

const BADGE = {
  // Share of the icon's width; Steam draws icons at around 24px
  iconSize: "55%",
  // How far the icon's badge hangs off its bottom-right corner
  overhang: "2px",
  // Capsules dwarf icons, so theirs is a fixed size sitting inside the art
  capsuleSize: "26px",
  capsuleInset: "6px",
  radius: "20%",
  background: "#2a2a2a",
  // Epic's shield, drawn rather than fetched since the render path has no network
  logo:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E" +
    "%3Cpath fill='%23fff' d='M5.5 2h13a1.5 1.5 0 0 1 1.5 1.5v10.2c0 .5-.2.9-.6 1.2l-6.6 5.4a1.5 1.5 0 0 1-1.9 0L4.6 15a1.5 1.5 0 0 1-.6-1.2V3.5A1.5 1.5 0 0 1 5.5 2Z'/%3E" +
    "%3Cpath fill='%232a2a2a' d='M9 6h6v1.6h-4.2v2H14v1.6h-3.2v2.2H15V15H9Z'/%3E%3C/svg%3E",
  // Share of the badge the logo fills, leaving it a margin
  logoScale: "78%",
} as const;

type Kind = "icon" | "capsule";

// ELibraryAssetType: Capsule, Header (a featured capsule's art) and Icon
const KINDS: Partial<Record<number, Kind>> = { 0: "capsule", 3: "capsule", 4: "icon" };

const PLACEMENT = {
  icon: {
    right: `-${BADGE.overhang}`,
    bottom: `-${BADGE.overhang}`,
    width: BADGE.iconSize,
    height: BADGE.iconSize,
  },
  capsule: {
    right: BADGE.capsuleInset,
    bottom: BADGE.capsuleInset,
    width: BADGE.capsuleSize,
    height: BADGE.capsuleSize,
  },
} as const;

// Its own component, so a sync redraws the badge without Steam redrawing the art
function Mark({ kind }: { kind: Kind }) {
  // Icons clip to round their corners, which would cut off our overhang, and an avatar's
  // holder isn't always the box the badge is placed against
  const container = useRef<HTMLElement | null>(null);
  const fit = useCallback((badge: HTMLElement | null) => {
    if (badge?.parentElement) {
      container.current = badge.parentElement;
      container.current.style.overflow = "visible";
      if (getComputedStyle(container.current).position === "static") {
        container.current.style.position = "relative";
      }
    } else {
      container.current?.style.removeProperty("overflow");
      container.current?.style.removeProperty("position");
      container.current = null;
    }
  }, []);

  return createElement("div", {
    ref: kind === "icon" ? fit : undefined,
    style: {
      ...PLACEMENT[kind],
      position: "absolute",
      zIndex: 1,
      borderRadius: BADGE.radius,
      background: `${BADGE.background} url("${BADGE.logo}") center / ${BADGE.logoScale} no-repeat`,
      boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.6)",
      pointerEvents: "none",
    },
  });
}

function Badge({ appId, kind }: { appId: number; kind: Kind }) {
  const epic = useSyncExternalStore(
    library.subscribe,
    () => library.getByAppId(appId) !== undefined,
  );

  return epic ? createElement(Mark, { kind }) : null;
}

export function LibraryBadge(appId: number | undefined, assetType: number) {
  const kind = KINDS[assetType];
  if (appId === undefined || !kind) return null;
  return createElement(Badge, { appId, kind });
}

// An avatar's children, with the mark added when the persona is an Epic friend's
export function FriendBadge(persona: object | undefined, children: ReactNode) {
  if (!isEpicPersona(persona)) return children;
  return createElement(Fragment, null, children, createElement(Mark, { kind: "icon" }));
}
