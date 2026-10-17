import { afterPatch, ConfirmModal, MenuItem, showModal } from "millennium";
import { createElement, cloneElement, Children, type ReactElement, type ReactNode } from "react";
import { getFiber } from "../services/fiber";
import { findExport } from "../services/modules";
import { memo } from "../services/once";
import { mainPopup, onPopupCreate } from "../services/popups";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// Manage has no Uninstall for shortcuts, so we patch `BuildManageSubmenu`, whose
// unexported class we find in the first open menu's React tree.

interface ManageMenuInstance {
  BuildManageSubmenu(...args: unknown[]): ReactElement;
  forceUpdate(): void;
}

/** The menu class instance under `root`: an ancestor, so climb to the React root first. */
function findManageMenu(root: Element): ManageMenuInstance | undefined {
  let fiber = getFiber(root);
  if (!fiber) {
    for (const child of root.querySelectorAll("*")) {
      fiber = getFiber(child);
      if (fiber) break;
    }
  }
  if (!fiber) return undefined;

  while (fiber.return) fiber = fiber.return;

  // An index rather than shift(), which is linear: a menu's tree is thousands deep.
  const queue = [fiber];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const node = current.stateNode as ManageMenuInstance | null;
    if (typeof node?.BuildManageSubmenu === "function") return node;
    if (current.child) queue.push(current.child);
    if (current.sibling) queue.push(current.sibling);
  }

  return undefined;
}

/** Steam's uninstall dialog. It confirms through `OpenUninstallWizard`, which installs.ts intercepts. */
type UninstallDialog = (
  appIds: number[],
  ownerWindow: Window | undefined,
  confirmPassword: boolean,
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
        if (dialog) dialog([appId], mainPopup()?.window, false);
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

function patchPrototype(instance: ManageMenuInstance) {
  const prototype = Object.getPrototypeOf(instance) as ManageMenuInstance;

  return afterPatch(prototype, "BuildManageSubmenu", (args, ret: ReactElement) => {
    // Bulk selections stay Steam's: it only shows what every selected app supports.
    const apps = args[0] as { appid: number }[] | undefined;
    const app = apps?.length === 1 ? apps[0] : undefined;
    if (!ret || !app) return ret;

    const items = [cancelItem(app.appid), uninstallItem(app.appid)].filter(Boolean);
    if (items.length === 0) return ret;

    const children = Children.toArray((ret.props as { children?: ReactNode }).children);

    return cloneElement(ret, undefined, ...children, ...items);
  }).unpatch;
}

/** A cheap check before walking the fiber tree, since DOM mutations are constant. */
function looksLikeMenu(node: Element, shallow: boolean): boolean {
  const className = typeof node.className === "string" ? node.className : "";
  if (/contextmenu/i.test(className)) return true;

  // The subtree query only for top-level nodes, where menu portals mount; a theme
  // loading is thousands of other renders.
  return shallow && node.querySelector('[class*="ontextMenu"]') !== null;
}

export function register() {
  let unpatch: (() => void) | undefined;
  let missed = false;
  const observers: MutationObserver[] = [];

  function capture(root: Element | undefined, retries = 3, shallow = true) {
    if (unpatch || !root || !looksLikeMenu(root, shallow)) return;

    const instance = findManageMenu(root);
    if (!instance) {
      // The class appears a commit after the nodes, and no more mutations follow.
      if (retries > 0) {
        setTimeout(() => capture(root, retries - 1, shallow), 100);
        return;
      }

      // Most context menus aren't an app's, so say it once.
      if (!missed) {
        missed = true;
        console.debug("Saw a context menu with no app actions in it");
      }
      return;
    }

    unpatch = patchPrototype(instance);
    console.debug("Patched the manage menu");

    // The menu that handed us the prototype was built before the patch.
    instance.forceUpdate();

    for (const observer of observers) observer.disconnect();
    observers.length = 0;
  }

  // A context menu is sometimes a popup, sometimes in its opener's window.
  function observe(root: Element | undefined) {
    if (!root) return undefined;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          // `instanceof Element` fails across windows.
          if (node.nodeType === 1) capture(node as Element, 3, record.target === root);
          if (unpatch) return;
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    observers.push(observer);

    return () => {
      observer.disconnect();
      const index = observers.indexOf(observer);
      if (index >= 0) observers.splice(index, 1);
    };
  }

  // The main window included. Popups are empty at creation, so the observer finds
  // the menu; the immediate try catches one already rendered.
  const unwatch = onPopupCreate((popup) => {
    if (unpatch) return;

    const disconnect = observe(popup.root_element);
    capture(popup.root_element);
    return disconnect;
  });

  console.debug("Registered the manage menu patch");

  return () => {
    unwatch();
    for (const observer of observers) observer.disconnect();
    unpatch?.();
  };
}
