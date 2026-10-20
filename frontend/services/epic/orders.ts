import { ChromeDevToolsProtocol as cdp } from "millennium";
import * as appIds from "../../state/app-ids";
import * as library from "../../state/library";
import { notify } from "../steam/notifications";
import { autoSync } from "../sync/sync";
import { isEpicTab } from "./session";
import { isEpicHost } from "./store";

// Orders placed in the Epic tabs session follows are spotted two ways, since neither
// covers every flow: a checkout page or frame closing, and the request that places the
// order. A false alarm costs one library refresh

// Epic takes a moment to list an order, and an order is several requests
const AFTER_CHECKOUT_MS = 5_000;
// A second look for an order Epic hadn't listed by the first
const RETRY_AFTER_MS = 60_000;

// Under /proxy/api/purchase/: `quick-purchase` adds a free game without checkout and
// `confirm-order` is checkout's Place Order. Neighbours like `offer-entitlements` are
// lookups every product page makes, so the path's last part has to match
const ORDER_ENDPOINT = /\/(quick-purchase|confirm-order|place-order)\/?$/i;

// Telemetry fires constantly and orders nothing
function epicPath(url: string) {
  try {
    const { hostname, pathname } = new URL(url);
    const telemetry = /tracking|telemetry|datarouter|analytics|metrics/i.test(hostname);
    return isEpicHost(hostname) && !telemetry ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function isCheckout(url: string) {
  return /\/purchase(\/|$)/.test(epicPath(url) ?? "");
}

// The protocol's types aren't installed, so the events' fields are spelled out
interface Events {
  "Page.frameNavigated": { frame: { id: string; url: string }; sessionId?: string };
  "Page.frameDetached": { frameId: string; sessionId?: string };
  "Network.requestWillBeSent": { request: { url: string; method: string }; sessionId?: string };
  "Target.detachedFromTarget": { sessionId?: string };
}

function on<E extends keyof Events>(event: E, handler: (params: Events[E]) => void) {
  return cdp.on(event, (params) => handler(params as Events[E]));
}

function announce(games: EpicGame[]) {
  const one = games.length === 1;
  const names = games.slice(0, 2).map((game) => game.title);
  if (games.length > 2) names.push(`${games.length - 2} more`);
  const list = names.join(names.length > 2 ? ", " : " and ");

  const inSteam = games.every((game) => appIds.getAppId(game.app_name) !== undefined);
  notify(
    one ? "New Epic game" : `${games.length} new Epic games`,
    inSteam
      ? `${list} ${one ? "is" : "are"} in your Steam library.`
      : `Found ${list}. Add ${one ? "it" : "them"} to Steam from the plugin's page.`,
  );
}

export function watch() {
  // Checkout frames open per session, as all of epicgames.com shares one process
  const checkouts = new Map<string, Set<string>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  // The games owned when the current order was spotted, to tell what it added
  let before: Set<string> | undefined;

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  // Refreshes and syncs, then says what arrived; returns whether anything did
  const look = async (last: boolean) => {
    const result = await library.load(true, true);
    if (result.error) {
      notify("Couldn't check your Epic library", result.error);
      return true;
    }

    await autoSync(result);

    const added = result.games.filter((game) => !before?.has(game.app_name));
    if (added.length > 0) announce(added);
    else if (last) notify("No new Epic games", "Nothing new showed up in your library after that.");
    return added.length > 0;
  };

  const possibleOrder = (reason: string) => {
    console.info("Possible Epic order", reason);

    // A burst of signals is one order: announced once, refreshed after the last
    if (timers.size === 0) {
      before = new Set(library.getLatest()?.games.map((game) => game.app_name));
      notify("Checking your Epic library", "Looks like you got a game on the Epic store.");
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
    on("Page.frameNavigated", ({ frame, sessionId }) => {
      if (isEpicTab(sessionId)) setCheckout(sessionId, frame.id, isCheckout(frame.url));
    }),
    on("Page.frameDetached", ({ frameId, sessionId }) => {
      if (isEpicTab(sessionId)) setCheckout(sessionId, frameId, false);
    }),
    on("Network.requestWillBeSent", ({ request, sessionId }) => {
      if (!isEpicTab(sessionId) || request.method !== "POST") return;

      const path = epicPath(request.url);
      if (path && ORDER_ENDPOINT.test(path)) possibleOrder(`request to ${path}`);
    }),
    // A tab closed mid-order still counts as the checkout closing
    on("Target.detachedFromTarget", ({ sessionId }) => {
      if (sessionId && checkouts.delete(sessionId)) possibleOrder("tab closed during checkout");
    }),
  ];

  return () => {
    for (const off of offs) off();
    for (const timer of timers) clearTimeout(timer);
  };
}
