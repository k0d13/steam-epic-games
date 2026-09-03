import { afterPatch, ConfirmModal, MenuItem, showModal } from "@steambrew/client";
import { createElement, cloneElement, Children, type ReactElement, type ReactNode } from "react";
import { logger } from "../index";
import { findExport } from "../services/modules";
import { memo } from "../services/once";
import { mainPopup, onPopupCreate } from "../services/popups";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// Steam's Manage submenu has no Uninstall for a non-Steam shortcut. The list is
// hardcoded per app type in an unexported function, and the only way to change
// which list we get - claiming to be a normal app - would change what a shortcut
// is everywhere else in the client.
//
// So the item is added to the rendered submenu instead. `BuildManageSubmenu` is
// a method on the context menu's class, which is never exported but does have
// an instance in every open menu's React tree: the first menu we see hands us
// the prototype, and every menu after it - including that one, via
// `forceUpdate` - is ours.
//
// Nothing is removed. "Remove non-Steam game" drops the shortcut and un-syncs
// the game, which is a different thing from uninstalling it.

interface ManageMenuInstance {
  BuildManageSubmenu(...args: unknown[]): ReactElement;
  forceUpdate(): void;
}

interface Fiber {
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}

/**
 * The React fiber for a DOM node. Stored under a key with a build-specific
 * suffix, hence the scan.
 */
function getFiber(node: Element): Fiber | undefined {
  for (const key of Object.keys(node)) {
    if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactContainer$")) continue;
    return Reflect.get(node, key) as Fiber;
  }
  return undefined;
}

function isManageMenu(value: unknown): value is ManageMenuInstance {
  return typeof (value as ManageMenuInstance | null)?.BuildManageSubmenu === "function";
}

/**
 * The class instance behind a menu somewhere under `root`. The fiber a DOM node
 * carries is that node's own, and the class we want rendered it - an ancestor -
 * so this climbs to the React root before walking down.
 */
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

  const queue: Fiber[] = [fiber];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (isManageMenu(current.stateNode)) return current.stateNode;
    if (current.child) queue.push(current.child);
    if (current.sibling) queue.push(current.sibling);
  }

  return undefined;
}

/**
 * Steam's own uninstall dialog. It renders from the appid alone and confirms by
 * calling `SteamClient.Installs.OpenUninstallWizard`, which installs.ts
 * intercepts - so an Epic game gets Steam's exact dialog for free.
 */
type UninstallDialog = (
  appIds: number[],
  ownerWindow: Window | undefined,
  confirmPassword: boolean,
) => void;

/** The dialog opener, told apart from the error dialog in the same module. */
function isUninstallDialog(value: unknown): value is UninstallDialog {
  if (typeof value !== "function") return false;
  const source = value.toString();
  return source.includes("#UninstallDialog_Title") && source.includes("small_mode");
}

const getUninstallDialog = memo(() => {
  const dialog = findExport("#UninstallDialog_Title", isUninstallDialog);
  if (!dialog) logger.warn("Steam's uninstall dialog wasn't found, using our own");
  return dialog;
});

/**
 * Our own dialog, for the day Steam's stops being findable. It calls the job
 * directly, since nothing would have opened `OpenUninstallWizard`.
 */
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

function confirmUninstall(appId: number, appName: string, name: string) {
  const dialog = getUninstallDialog();
  if (dialog) dialog([appId], mainPopup()?.window, false);
  else fallbackConfirm(appName, name);
}

/** The item itself, or nothing when this app has no uninstall to offer. */
function uninstallItem(appId: number): ReactNode {
  const game = library.getByAppId(appId);
  if (!game?.installed) return undefined;

  // A job of either kind is already touching these files, or is about to.
  const job = jobs.get(game.appName);
  if (job?.state === "running" || job?.state === "queued") return undefined;

  return createElement(
    MenuItem,
    {
      key: "epic-uninstall",
      tone: "destructive",
      onSelected: () => confirmUninstall(appId, game.appName, game.title),
    },
    "Uninstall",
  );
}

/**
 * Steam offers Cancel on anything in its download queue, running or waiting, so
 * ours does too - it's the only way out of a queued install otherwise.
 *
 * Unlike Steam's, this leaves what was already downloaded where it is: that's
 * what lets Install resume it, and legendary has no notion of a partial install
 * to uninstall.
 */
function cancelItem(appId: number): ReactNode {
  const game = library.getByAppId(appId);
  const job = game && jobs.get(game.appName);
  if (job?.kind !== "install" && job?.kind !== "update") return undefined;
  if (job.state !== "queued" && job.state !== "running" && job.state !== "paused") {
    return undefined;
  }

  return createElement(
    MenuItem,
    {
      key: "epic-cancel",
      onSelected: () => void jobs.cancel(job.appName),
    },
    job.kind === "update" ? "Cancel update" : "Cancel download",
  );
}

interface OverviewLike {
  appid: number;
}

function patchPrototype(instance: ManageMenuInstance) {
  const prototype = Object.getPrototypeOf(instance) as ManageMenuInstance;

  return afterPatch(prototype, "BuildManageSubmenu", (args, ret: ReactElement) => {
    // Bulk selections are Steam's own path: it shows only what every app in
    // the selection supports, and ours wouldn't be true of all of them.
    const apps = args[0] as OverviewLike[] | undefined;
    const app = apps?.length === 1 ? apps[0] : undefined;
    if (!ret || !app) return ret;

    const items = [cancelItem(app.appid), uninstallItem(app.appid)].filter(Boolean);
    if (items.length === 0) return ret;

    const children = Children.toArray((ret.props as { children?: ReactNode }).children);

    return cloneElement(ret, undefined, ...children, ...items);
  }).unpatch;
}

/**
 * A cheap test for "worth walking a fiber tree over", since the walk searches
 * the whole tree and DOM mutations are constant.
 */
function looksLikeMenu(node: Element, shallow: boolean): boolean {
  const className = typeof node.className === "string" ? node.className : "";
  if (/contextmenu/i.test(className)) return true;

  // The subtree search only for a node mounted at the top of the tree, which is
  // where a menu's portal goes. Everything else added to a window is a render -
  // a theme loading is thousands of them, and each would cost a query over its
  // own subtree.
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
      // The menu's nodes land in the DOM a commit before its class appears in
      // the fiber tree, and there are no more mutations once it has opened - so
      // without the retries we'd be waiting for the next menu.
      if (retries > 0) {
        setTimeout(() => capture(root, retries - 1, shallow), 100);
        return;
      }

      // Every context menu comes through here, most of them not an app's, so
      // this is only worth saying once.
      if (!missed) {
        missed = true;
        logger.debug("Saw a context menu with no app actions in it");
      }
      return;
    }

    unpatch = patchPrototype(instance);
    logger.debug("Patched the manage menu");

    // The menu that handed us the prototype was built before the patch, so it
    // would be the one without our item in it.
    instance.forceUpdate();

    for (const observer of observers) observer.disconnect();
    observers.length = 0;
  }

  // A context menu is a popup only sometimes; otherwise it renders into the
  // window it was opened from. So both are watched until one finds the class.
  function observe(root: Element | undefined) {
    if (!root) return undefined;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          // `node instanceof Element` is always false: the menu belongs to
          // another window, and instanceof doesn't cross realms.
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

  observe(mainPopup()?.root_element);

  // Every popup, whatever it says it is. The window is empty at create time, so
  // the observer is what finds the menu; the immediate attempt is for one that
  // has already rendered.
  const unwatch = onPopupCreate((popup, handlers) => {
    if (unpatch) return;

    const disconnect = observe(popup.root_element);
    capture(popup.root_element);
    handlers.onOpen(() => capture(popup.root_element));
    handlers.onClose(() => disconnect?.());
  });

  logger.debug("Registered the manage menu patch");

  return () => {
    unwatch();
    for (const observer of observers) observer.disconnect();
    unpatch?.();
  };
}
