export const EPIC_STORE = "https://store.epicgames.com";

// Where epic/session picks the account up from
export const SIGN_IN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(`${EPIC_STORE}/`)}`;

export function searchURL(query: string) {
  return `${EPIC_STORE}/browse?q=${encodeURIComponent(query)}`;
}

export function isEpicHost(hostname: string) {
  return hostname === "epicgames.com" || hostname.endsWith(".epicgames.com");
}

// Epic's storefront, sign in and checkout; Steam's `GetTabForURL` asks this so Epic's
// pages light Store rather than whichever tab was last
export function IsEpicURL(url: string) {
  try {
    return isEpicHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function open(url: string) {
  const browser = window.MainWindowBrowserManager as { ShowURL(url: string): void } | undefined;
  if (!browser) {
    console.warn("The main window browser isn't there to open the store in");
    return;
  }
  browser.ShowURL(url);
}
