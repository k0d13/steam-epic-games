const HIDE_DOWNLOAD_ID = "epic-games-hide-download";

// The header keeps the button in its shadow root, out of a page stylesheet's reach, and
// can draw after this runs, so the style goes in there once the header turns up; webkit
// scripts run in an isolated world, where customElements is null, so page changes it is
export function hideLauncherDownload() {
  function hide() {
    const root = document.querySelector("egs-navigation")?.shadowRoot;
    if (!root || root.getElementById(HIDE_DOWNLOAD_ID)) return;

    const style = document.createElement("style");
    style.id = HIDE_DOWNLOAD_ID;
    style.textContent = ".main-cta { display: none !important; }";
    root.append(style);
  }

  hide();
  new MutationObserver(hide).observe(document, { childList: true, subtree: true });
}
