import { ChromeDevToolsProtocol as cdp } from "millennium";
import { poll } from "../../state/primitives";

// Keeps legendary signed in exactly when the Epic store in Steam's browser is. Webview
// scripts aren't injected into other sites, so the store's tab is driven over the DevTools
// protocol: signed in, it's sent to Epic's redirect endpoint for a code and back

const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
const FALLBACK_RETURN = "https://store.epicgames.com/";
const POLL_MS = 1500;

interface Tab {
  sessionId: string;
  // Where to go back to once the redirect page has given up its code
  returnTo?: string;
  // A code was asked for while the store said signed in; cleared on signed out
  tried: boolean;
  // Sent back from the redirect page, which polls can still list until it's gone
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

export function isEpicTab(sessionId: string | undefined): sessionId is string {
  return [...tabs.values()].some((tab) => tab.sessionId === sessionId);
}

async function evaluate<T>(sessionId: string, expression: string) {
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

function detach(sessionId: string) {
  return cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
}

async function attach(targetId: string) {
  const known = tabs.get(targetId);
  if (known) return known;

  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  // Frame and request events, which orders watches
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  const tab: Tab = { sessionId, tried: false };
  tabs.set(targetId, tab);
  return tab;
}

// On the redirect page: hand the code to the backend, then send the tab back
async function capture(tab: Tab) {
  if (tab.leaving) return;
  const text = await evaluate<string>(tab.sessionId, "document.body?.innerText ?? ''");

  let code: string | undefined;
  try {
    const parsed = JSON.parse(text ?? "") as { authorizationCode?: string | null };
    code = parsed.authorizationCode ?? undefined;
  } catch {
    // Still loading, or not JSON; the next poll looks again
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

// On a store page: bring legendary in line with what its header says
async function follow(tab: Tab, url: string) {
  tab.leaving = false;
  const loggedIn = await evaluate<string | null>(
    tab.sessionId,
    "document.querySelector('egs-navigation')?.getAttribute('isloggedin') ?? null",
  );
  // The header draws after the page; until then there's nothing to go on
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

function parseUrl(url: string) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

async function visit(targetId: string, url: URL) {
  try {
    const tab = await attach(targetId);
    if (isRedirect(url)) await capture(tab);
    else await follow(tab, url.href);
  } catch (e) {
    // A session dies with its page; attach afresh next time
    console.warn("Couldn't follow an Epic tab", url.href, e);
    tabs.delete(targetId);
  }
}

let busy = false;

async function scan() {
  if (busy) return;
  busy = true;

  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const live = new Set<string>();
    const visits: Promise<void>[] = [];

    for (const target of targetInfos) {
      const url = target.type === "page" ? parseUrl(target.url) : undefined;
      if (!url || !(isStore(url) || isRedirect(url))) continue;

      live.add(target.targetId);
      visits.push(visit(target.targetId, url));
    }

    await Promise.all(visits);

    // Epic's sign in page runs a bot check that a debugger left attached can fail
    for (const [targetId, { sessionId }] of tabs) {
      if (live.has(targetId)) continue;
      tabs.delete(targetId);
      void detach(sessionId);
    }
  } catch (e) {
    console.warn("Couldn't list Steam's browser tabs", e);
  } finally {
    busy = false;
  }
}

export function start() {
  const stop = poll(() => void scan(), POLL_MS);

  return () => {
    stop();
    for (const { sessionId } of tabs.values()) void detach(sessionId);
    tabs.clear();
  };
}
