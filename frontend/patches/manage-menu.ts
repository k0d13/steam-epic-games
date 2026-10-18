import { ConfirmModal, MenuItem, showModal } from "millennium";
import { createElement, cloneElement, Children, type ReactElement, type ReactNode } from "react";
import { findExport } from "../services/modules";
import { memo } from "../services/once";
import { mainPopup } from "../services/popups";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// Manage has no Uninstall for shortcuts. backend/patches.lua passes what Steam's
// `BuildManageSubmenu` built through `ManageSubmenu`, which adds ours.

/** Steam's uninstall dialog. It confirms through `OpenUninstallWizard`, which installs.ts intercepts. */
type UninstallDialog = (
  appIds: number[],
  ownerWindow: Window | undefined,
  confirmPassword: boolean,
  remoteClientId: string,
) => void;

const getUninstallDialog = memo(() => {
  // `small_mode` tells the dialog opener apart from the error dialog in the same module.
  const dialog = findExport(
    "#UninstallDialog_Title",
    (value): value is UninstallDialog =>
      typeof value === "function" && value.toString().includes("small_mode"),
  );
  if (!dialog) console.warn("Steam's uninstall dialog wasn't found, using our own");
  return dialog;
});

/** Our own dialog for when Steam's can't be found; it calls the job directly. */
function fallbackConfirm(appName: string, name: string) {
  showModal(
    createElement(ConfirmModal, {
      strTitle: `Uninstall ${name}`,
      strDescription: `This deletes ${name}'s files from your disk. It stays in your library.`,
      strOKButtonText: "Uninstall",
      bDestructiveWarning: true,
      onOK: () => void jobs.uninstall(appName),
    }),
    // Explicit because showModal's default, findSP(), throws on this build.
    mainPopup()?.window,
  );
}

/** The item itself, or nothing when this app has no uninstall to offer. */
function uninstallItem(appId: number): ReactNode {
  const game = library.getByAppId(appId);
  if (!game?.installed) return undefined;

  // A job of either kind is already touching these files, or is about to.
  const job = jobs.get(game.app_name);
  if (job?.state === "running" || job?.state === "queued") return undefined;

  return createElement(
    MenuItem,
    {
      key: "epic-uninstall",
      tone: "destructive",
      onSelected: () => {
        const dialog = getUninstallDialog();
        if (dialog) dialog([appId], mainPopup()?.window, false, "0");
        else fallbackConfirm(game.app_name, game.title);
      },
    },
    "Uninstall",
  );
}

/**
 * Cancel for queued, running or paused downloads, like Steam's. Unlike Steam's, it
 * keeps the partial download so Install can resume it.
 */
function cancelItem(appId: number): ReactNode {
  const game = library.getByAppId(appId);
  const job = game && jobs.get(game.app_name);
  if (job?.kind !== "install" && job?.kind !== "update") return undefined;
  if (job.state !== "queued" && job.state !== "running" && job.state !== "paused") {
    return undefined;
  }

  return createElement(
    MenuItem,
    {
      key: "epic-cancel",
      onSelected: () => void jobs.cancel(job.app_name),
    },
    job.kind === "update" ? "Cancel update" : "Cancel download",
  );
}

/** Called from Steam's own code, with the menu it built for the selected apps. */
export function ManageSubmenu(menu: ReactElement | undefined, apps: { appid: number }[]) {
  // Bulk selections stay Steam's: it only shows what every selected app supports.
  const app = apps.length === 1 ? apps[0] : undefined;
  if (!menu || !app) return menu;

  const items = [cancelItem(app.appid), uninstallItem(app.appid)].filter(Boolean);
  if (items.length === 0) return menu;

  const children = Children.toArray((menu.props as { children?: ReactNode }).children);

  return cloneElement(menu, undefined, ...children, ...items);
}
