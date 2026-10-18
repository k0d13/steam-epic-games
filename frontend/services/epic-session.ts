import { ChromeDevToolsProtocol as cdp } from "millennium";
import { createEmitter } from "../state/emitter";

// Keeps legendary signed in exactly when the Epic store in Steam's browser is.
// Millennium doesn't inject webview scripts into sites other than Steam's, so this
// drives the store's tab from here over the DevTools protocol instead.
//
// Signed in, Epic's redirect endpoint answers with an authorization code for
// legendary's client id, printed as JSON; the tab is sent there and back for it.

/** legendary's client id, which the code is only good for. */
const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";

const REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;

const FALLBACK_RETURN = "https://store.epicgames.com/";

const POLL_MS = 1500;

interface Tab {
  sessionId: string;
  /** Where to go back to once the redirect page has given up its code. */
  returnTo?: string;
  /** A code was asked for while the store said signed in; cleared on signed out. */
  tried: boolean;
  /** Sent back from the redirect page, which polls can still list until it's gone. */
  leaving?: boolean;
}

const tabs = new Map<string, Tab>();

function isStore(url: URL) {
  return url.hostname === "store.epicgames.com";
}

function isRedirect(url: URL) {
  return (
    url.hostname === "www.epicgames.com" &&
    url.pathname === "/id/api/redirect" &&
    url.searchParams.get("clientId") === CLIENT_ID
  );
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T | undefined> {
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    sessionId,
  );
  return result.value as T | undefined;
}

function navigate(sessionId: string, url: string) {
  return cdp.send("Page.navigate", { url }, sessionId);
}

async function attach(targetId: string): Promise<Tab> {
  const known = tabs.get(targetId);
  if (known) return known;

  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  // Frame and request events, for spotting an order (see watchOrders).
  sessions.add(sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  const tab: Tab = { sessionId, tried: false };
  tabs.set(targetId, tab);
  return tab;
}

/** On the redirect page: hand the code to the backend, then send the tab back. */
async function capture(tab: Tab) {
  if (tab.leaving) return;
  const text = await evaluate<string>(tab.sessionId, "document.body?.innerText ?? ''");

  let code: string | undefined;
  try {
    code =
      (JSON.parse(text ?? "") as { authorizationCode?: string | null }).authorizationCode ??
      undefined;
  } catch {
    // Still loading, or not JSON; the next poll looks again.
    return;
  }

  if (code) {
    const result = await backend.SignIn(code);
    if (result.authenticated) console.info("Signed legendary in from the store as", result.account);
    else console.warn("Signing legendary in from the store failed", result.error);
  } else {
    console.warn("Epic's redirect page had no code, though the store said signed in");
  }

  const back = tab.returnTo ?? FALLBACK_RETURN;
  tab.returnTo = undefined;
  tab.leaving = true;
  await navigate(tab.sessionId, back);
}

/** On a store page: bring legendary in line with what its header says. */
async function follow(tab: Tab, url: string) {
  tab.leaving = false;
  const loggedIn = await evaluate<string | null>(
    tab.sessionId,
    "document.querySelector('egs-navigation')?.getAttribute('isloggedin') ?? null",
  );
  // The header draws after the page; until then there's nothing to go on.
  if (loggedIn !== "true" && loggedIn !== "false") return;

  const status = await backend.GetStatus(false);
  if (!status.available) return;

  if (loggedIn === "false") {
    tab.tried = false;
    if (status.authenticated) {
      console.info("The store is signed out, so signing legendary out");
      await backend.SignOut();
    }
    return;
  }

  if (status.authenticated || tab.tried) return;
  tab.tried = true;
  tab.returnTo = url;
  console.info("The store is signed in, fetching a code for legendary");
  await navigate(tab.sessionId, REDIRECT_URL);
}

let busy = false;

async function poll() {
  if (busy) return;
  busy = true;

  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const live = new Set<string>();

    for (const target of targetInfos) {
      if (target.type !== "page") continue;

      let url: URL;
      try {
        url = new URL(target.url);
      } catch {
        continue;
      }
      if (!isStore(url) && !isRedirect(url)) continue;

      live.add(target.targetId);
      try {
        const tab = await attach(target.targetId);
        if (isRedirect(url)) await capture(tab);
        else await follow(tab, target.url);
      } catch (e) {
        // A session dies with its page; attach afresh next time.
        console.warn("Couldn't follow an Epic tab", target.url, e);
        tabs.delete(target.targetId);
      }
    }

    for (const targetId of tabs.keys()) if (!live.has(targetId)) tabs.delete(targetId);
  } catch (e) {
    console.warn("Couldn't list Steam's browser tabs", e);
  } finally {
    busy = false;
  }
}

// Buying or claiming a game reaches the library without the plugin asking, so
// the store's tabs are watched for an order. Two signals, since neither covers
// every flow: Epic's checkout, a /purchase page or frame, closing; and the request
// that places an order, which is how a Get adds a free game with no checkout.

/** Sessions this module attached, so other plugins' tabs aren't read. */
const sessions = new Set<string>();

/** Checkout frames open per session; all of epicgames.com shares one process. */
const checkouts = new Map<string, Set<string>>();

const orderEmitter = createEmitter();

/** Hear that an order may just have gone through in Steam's browser. */
export const onPossibleOrder = orderEmitter.subscribe;

function possibleOrder(reason: string) {
  console.info("Possible Epic order", reason);
  orderEmitter.emit();
}

/** An Epic host that isn't telemetry, which fires constantly and orders nothing. */
function epicHost(url: URL) {
  const { hostname } = url;
  const epic = hostname === "epicgames.com" || hostname.endsWith(".epicgames.com");
  return epic && !/tracking|telemetry|datarouter|analytics|metrics/i.test(hostname);
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isCheckout(url: string) {
  const parsed = parse(url);
  return parsed !== undefined && epicHost(parsed) && /\/purchase(\/|$)/.test(parsed.pathname);
}

/**
 * The store's order endpoints, under /proxy/api/purchase/: `quick-purchase` is a
 * Get that adds a free game without checkout, `confirm-order` is checkout's
 * Place Order. Its neighbours there, like `offer-entitlements` and `bulk-pricing`,
 * are lookups every product page makes, so the path's last part has to match.
 */
const ORDER_ENDPOINT = /\/(quick-purchase|confirm-order|place-order)\/?$/i;

function isOrderRequest(url: string, method: string) {
  if (method !== "POST") return false;
  const parsed = parse(url);
  return parsed !== undefined && epicHost(parsed) && ORDER_ENDPOINT.test(parsed.pathname);
}

function setCheckout(sessionId: string, frameId: string, open: boolean) {
  let frames = checkouts.get(sessionId);

  if (open) {
    if (!frames) checkouts.set(sessionId, (frames = new Set()));
    frames.add(frameId);
    return;
  }

  if (!frames?.delete(frameId)) return;
  if (frames.size === 0) checkouts.delete(sessionId);
  possibleOrder("checkout closed");
}

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

function watchOrders(): () => void {
  const ours = (sessionId: string | undefined): sessionId is string =>
    sessionId !== undefined && sessions.has(sessionId);

  const offs = [
    cdp.on("Page.frameNavigated", (params) => {
      const { frame, sessionId } = params as FrameNavigated;
      if (ours(sessionId)) setCheckout(sessionId, frame.id, isCheckout(frame.url));
    }),
    cdp.on("Page.frameDetached", (params) => {
      const { frameId, sessionId } = params as FrameDetached;
      if (ours(sessionId)) setCheckout(sessionId, frameId, false);
    }),
    cdp.on("Network.requestWillBeSent", (params) => {
      const { request, sessionId } = params as RequestWillBeSent;
      if (!ours(sessionId)) return;
      if (isOrderRequest(request.url, request.method)) {
        possibleOrder(`request to ${parse(request.url)?.pathname ?? request.url}`);
      }
    }),
    cdp.on("Target.detachedFromTarget", (params) => {
      const { sessionId } = params as { sessionId?: string };
      if (!ours(sessionId)) return;
      sessions.delete(sessionId);
      // A tab closed mid-order still counts as the checkout closing.
      if (checkouts.delete(sessionId)) possibleOrder("tab closed during checkout");
    }),
  ];

  return () => {
    for (const off of offs) off();
    checkouts.clear();
  };
}

export function start(): () => void {
  const stopWatching = watchOrders();
  void poll();
  const timer = setInterval(() => void poll(), POLL_MS);
  return () => {
    stopWatching();
    clearInterval(timer);
    for (const { sessionId } of tabs.values()) {
      void cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    tabs.clear();
  };
}
