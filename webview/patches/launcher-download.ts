const HIDE_DOWNLOAD_ID = "epic-games-hide-download";

// The button sits in the header's shadow root, which can draw after this runs, so the style
// goes in once it turns up; customElements is null in the isolated world, so watch the page
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
