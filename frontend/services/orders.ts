import { ChromeDevToolsProtocol as cdp } from "millennium";
import * as appIds from "../state/app-ids";
import * as library from "../state/library";
import { isEpicTab } from "./epic-session";
import { toast } from "./notifications";
import { autoSync } from "./steam-library";

// Buying or claiming a game reaches the library without the plugin asking, so the
// Epic tabs epic-session follows are watched for an order. Two signals, since
// neither covers every flow: Epic's checkout, a /purchase page or frame, closing;
// and the request that places an order, which is how a Get adds a free game with no
// checkout. A false alarm costs one library refresh.

/** Epic takes a moment to list an order, and an order is several requests; waited after the last. */
const AFTER_CHECKOUT_MS = 5_000;

/** A second look for an order Epic hadn't listed by the first. */
const RETRY_AFTER_MS = 60_000;

/**
 * The store's order endpoints, under /proxy/api/purchase/: `quick-purchase` is a
 * Get that adds a free game without checkout, `confirm-order` is checkout's
 * Place Order. Its neighbours there, like `offer-entitlements` and `bulk-pricing`,
 * are lookups every product page makes, so the path's last part has to match.
 */
const ORDER_ENDPOINT = /\/(quick-purchase|confirm-order|place-order)\/?$/i;

/** The path of an Epic URL that isn't telemetry, which fires constantly and orders nothing. */
function epicPath(url: string): string | undefined {
  try {
    const { hostname, pathname } = new URL(url);
    const epic = hostname === "epicgames.com" || hostname.endsWith(".epicgames.com");
    const telemetry = /tracking|telemetry|datarouter|analytics|metrics/i.test(hostname);
    return epic && !telemetry ? pathname : undefined;
  } catch {
    return undefined;
  }
}

const isCheckout = (url: string) => /\/purchase(\/|$)/.test(epicPath(url) ?? "");

// The protocol's types aren't installed, so the events' fields are spelled out.
interface FrameNavigated {
  frame: { id: string; url: string };
  sessionId?: string;
}

interface FrameDetached {
  frameId: string;
  sessionId?: string;
}

interface RequestWillBeSent {
  request: { url: string; method: string };
  sessionId?: string;
}

/** Name what an order added, and whether it's in Steam yet. */
function announce(games: EpicGame[]) {
  const one = games.length === 1;
  const names = games.slice(0, 2).map((game) => game.title);
  if (games.length > 2) names.push(`${games.length - 2} more`);
  const list = names.join(names.length > 2 ? ", " : " and ");

  const inSteam = games.every((game) => appIds.getAppId(game.app_name) !== undefined);
  toast(
    one ? "New Epic game" : `${games.length} new Epic games`,
    inSteam
      ? `${list} ${one ? "is" : "are"} in your Steam library.`
      : `Found ${list}. Add ${one ? "it" : "them"} to Steam from the plugin's page.`,
  );
}

/** Refresh the library, and so auto sync, after each order, until the returned function is called. */
export function watch(): () => void {
  /** Checkout frames open per session; all of epicgames.com shares one process. */
  const checkouts = new Map<string, Set<string>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  /** The games owned when the current order was spotted, to tell what it added. */
  let before: Set<string> | undefined;

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  /** Refresh and sync, then say what arrived. Returns whether anything did. */
  const look = async (last: boolean): Promise<boolean> => {
    const result = await library.load(true, true);
    if (result.error) {
      toast("Couldn't check your Epic library", result.error);
      return true;
    }

    await autoSync(result);

    const added = result.games.filter((game) => !before?.has(game.app_name));
    if (added.length > 0) announce(added);
    else if (last) toast("No new Epic games", "Nothing new showed up in your library after that.");
    return added.length > 0;
  };

  const possibleOrder = (reason: string) => {
    console.info("Possible Epic order", reason);

    // A burst of signals is one order: announced once, refreshed after the last.
    if (timers.size === 0) {
      before = new Set(library.getLatest()?.games.map((game) => game.app_name));
      toast("Checking your Epic library", "Looks like you got a game on the Epic store.");
    }
    for (const timer of timers) clearTimeout(timer);
    timers.clear();

    later(AFTER_CHECKOUT_MS, () => {
      void look(false)
        .then((found) => {
          if (!found) later(RETRY_AFTER_MS, () => void look(true).catch(() => {}));
        })
        .catch((reason: unknown) => console.warn("Refresh after an order failed", reason));
    });
  };

  const setCheckout = (sessionId: string, frameId: string, open: boolean) => {
    let frames = checkouts.get(sessionId);

    if (open) {
      if (!frames) checkouts.set(sessionId, (frames = new Set()));
      frames.add(frameId);
      return;
    }

    if (!frames?.delete(frameId)) return;
    if (frames.size === 0) checkouts.delete(sessionId);
    possibleOrder("checkout closed");
  };

  const offs = [
    cdp.on("Page.frameNavigated", (params) => {
      const { frame, sessionId } = params as FrameNavigated;
      if (isEpicTab(sessionId)) setCheckout(sessionId, frame.id, isCheckout(frame.url));
    }),
    cdp.on("Page.frameDetached", (params) => {
      const { frameId, sessionId } = params as FrameDetached;
      if (isEpicTab(sessionId)) setCheckout(sessionId, frameId, false);
    }),
    cdp.on("Network.requestWillBeSent", (params) => {
      const { request, sessionId } = params as RequestWillBeSent;
      if (!isEpicTab(sessionId) || request.method !== "POST") return;

      const path = epicPath(request.url);
      if (path && ORDER_ENDPOINT.test(path)) possibleOrder(`request to ${path}`);
    }),
    // A tab closed mid-order still counts as the checkout closing.
    cdp.on("Target.detachedFromTarget", (params) => {
      const { sessionId } = params as { sessionId?: string };
      if (sessionId && checkouts.delete(sessionId)) possibleOrder("tab closed during checkout");
    }),
  ];

  return () => {
    for (const off of offs) off();
    for (const timer of timers) clearTimeout(timer);
  };
}
