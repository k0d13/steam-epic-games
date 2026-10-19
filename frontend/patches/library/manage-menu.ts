import { findModuleExport, MenuItem } from "millennium";
import { Children, cloneElement, createElement, type ReactElement, type ReactNode } from "react";
import { mainPopup } from "../../services/steam/popups";
import * as jobs from "../../state/jobs";
import * as library from "../../state/library";

// Manage has no Uninstall or Cancel for shortcuts; backend/patches.lua passes what
// Steam's `BuildManageSubmenu` built through `ManageSubmenu`, which adds ours

// Confirms through OpenUninstallWizard, which downloads/installs intercepts
const showUninstallDialog = findModuleExport(
  (value) => typeof value === "function" && String(value).includes("ShowUninstallDialog()"),
) as
  | ((
      appIds: number[],
      owner: Window | undefined,
      confirmPassword: boolean,
      clientId: string,
    ) => void)
  | undefined;
if (!showUninstallDialog) {
  console.warn("Steam's uninstall dialog wasn't found, so Manage has no Uninstall");
}

export function ManageSubmenu(menu: ReactElement | undefined, apps: { appid: number }[]) {
  // Bulk selections stay Steam's, which only shows what every selected app supports
  const [app] = apps.length === 1 ? apps : [];
  const game = app && library.getByAppId(app.appid);
  if (!menu || !app || !game) return menu;

  const job = jobs.get(game.app_name);
  const busy = job?.state === "running" || job?.state === "queued";
  const items: ReactNode[] = [];

  // Like Steam's, but keeping the partial download so Install can resume it
  if (job && jobs.isDownload(job) && (busy || job.state === "paused")) {
    items.push(
      createElement(
        MenuItem,
        { key: "epic-cancel", onSelected: () => void jobs.cancel(game.app_name) },
        job.kind === "update" ? "Cancel update" : "Cancel download",
      ),
    );
  }

  // Not while a job is touching the files, or about to
  if (showUninstallDialog && game.installed && !busy) {
    items.push(
      createElement(
        MenuItem,
        {
          key: "epic-uninstall",
          tone: "destructive",
          onSelected: () => showUninstallDialog([app.appid], mainPopup()?.window, false, "0"),
        },
        "Uninstall",
      ),
    );
  }

  if (items.length === 0) return menu;

  const children = Children.toArray((menu.props as { children?: ReactNode }).children);
  return cloneElement(menu, undefined, ...children, ...items);
}
