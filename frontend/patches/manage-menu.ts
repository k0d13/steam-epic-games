import { afterPatch, ConfirmModal, MenuItem, showModal } from "@steambrew/client";
import { createElement, cloneElement, Children, type ReactElement, type ReactNode } from "react";
import { Steam } from "steambrew-utils";
import { onPopupCreate } from "steambrew-utils/watchers";
import { logger } from "../index";
import * as jobs from "../state/jobs";
import * as library from "../state/library";

// Steam's Manage submenu has no Uninstall for a non-Steam shortcut, and can't
// grow one from the data side. The list comes from `fe(overview, clientid)` in
// the app-actions module:
//
//   switch (overview.app_type) {
//     case Shortcut: return [RemoveShortcut, CreateDesktopShortcut];
//     ...
//
// - hardcoded, and `fe` isn't exported. The only other lever, making our games
// claim to be a normal app type, would change what a shortcut is everywhere
// else in the client: artwork, launch options, the non-Steam filters.
//
// So the item is added to the rendered submenu instead. `BuildManageSubmenu` is
// a method on the context menu's class, which is the one thing here that is
// reachable: the class is a `let` binding inside the module and never exported,
// but every open context menu has an instance of it in its React tree. So the
// first menu we see hands us the prototype, we patch that, and every menu after
// it - including the one that just opened, via `forceUpdate` - is ours.
//
// Nothing is removed. "Remove non-Steam game" still does what it says: it drops
// the shortcut and un-syncs the game, which is a different thing from
// uninstalling it and worth keeping.

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
 * The React fiber for a DOM node, if it has one. React stores it under a key
 * with a build-specific suffix, which is why this is a scan and not a lookup.
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
 * The class instance behind a menu somewhere under `root`.
 *
 * The fiber a DOM node carries is the *host* fiber for that node, and the class
 * we want rendered it - so it's an ancestor, not a descendant. Hence the climb
 * to the root before the walk down: searching from the node itself finds
 * nothing, however deep it goes.
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
 * Steam's own uninstall dialog - the one that darkens the window behind it
 * rather than opening a second one. It renders from the appid alone and
 * confirms by calling `SteamClient.Installs.OpenUninstallWizard`, which
 * `installs.ts` intercepts, so an Epic game gets Steam's exact dialog, in
 * Steam's language, for free.
 */
type UninstallDialog = (
  appIds: number[],
  ownerWindow: Window | undefined,
  confirmPassword: boolean,
) => void;

interface WebpackRequire {
  (id: string): Record<string, unknown>;
  m: Record<string, unknown>;
}

/** The dialog opener, told apart from the error dialog in the same module. */
function isUninstallDialog(value: unknown): value is UninstallDialog {
  if (typeof value !== "function") return false;
  const source = value.toString();
  return source.includes("#UninstallDialog_Title") && source.includes("small_mode");
}

/**
 * Found by hand rather than with `findModuleExport`, which searches the module
 * cache @steambrew/client built when it loaded - and the library's chunks load
 * later than that, so the dialog simply isn't in it.
 *
 * Module *factories* are functions, so they can be searched by source without
 * being run, and only the one that matches is required.
 */
function findUninstallDialog(): UninstallDialog | undefined {
  let webpackRequire: WebpackRequire | undefined;
  const id = Symbol("epic-games");
  const chunks = Reflect.get(globalThis, "webpackChunksteamui") as
    | { push(chunk: unknown[]): void }
    | undefined;
  chunks?.push([[id], {}, (r: WebpackRequire) => void (webpackRequire = r)]);
  if (!webpackRequire) return undefined;

  for (const moduleId of Object.keys(webpackRequire.m)) {
    const factory = webpackRequire.m[moduleId];
    if (typeof factory !== "function" || !factory.toString().includes("#UninstallDialog_Title")) {
      continue;
    }

    for (const value of Object.values(webpackRequire(moduleId))) {
      if (isUninstallDialog(value)) return value;
    }
  }

  return undefined;
}

let uninstallDialog: UninstallDialog | undefined;
let searched = false;

/**
 * Our own dialog, for the day Steam's stops being findable. Same shape, own
 * window rather than an overlay, and it skips `OpenUninstallWizard` because
 * nothing would have opened it.
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
    // Passed explicitly because showModal's own default, findSP(), reads a
    // gamepad navigation tree that no longer exists on this build and throws
    // before the modal is ever created.
    Steam.MainPopup?.window,
  );
}

function confirmUninstall(appId: number, appName: string, name: string) {
  if (!searched) {
    searched = true;
    uninstallDialog = findUninstallDialog();
    if (!uninstallDialog) logger.warn("Steam's uninstall dialog wasn't found, using our own");
  }

  if (uninstallDialog) uninstallDialog([appId], Steam.MainPopup?.window, false);
  else fallbackConfirm(appName, name);
}

/** The item itself, or nothing when this app has no uninstall to offer. */
function uninstallItem(appId: number): ReactNode {
  const game = library.getByAppId(appId);
  if (!game?.installed) return undefined;

  // A job of either kind is already touching these files.
  const job = jobs.get(game.appName);
  if (job?.state === "running") return undefined;

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

interface OverviewLike {
  appid: number;
}

function patchPrototype(instance: ManageMenuInstance) {
  const prototype = Object.getPrototypeOf(instance) as ManageMenuInstance;

  return afterPatch(prototype, "BuildManageSubmenu", (args, ret: ReactElement) => {
    // Bulk selections are Steam's own path - it filters the actions down to
    // what every app in the selection supports - and ours would be a lie there.
    const apps = args[0] as OverviewLike[] | undefined;
    const app = apps?.length === 1 ? apps[0] : undefined;
    if (!ret || !app) return ret;

    const item = uninstallItem(app.appid);
    if (!item) return ret;

    const children = Children.toArray((ret.props as { children?: ReactNode }).children);

    return cloneElement(ret, undefined, ...children, item);
  }).unpatch;
}

/**
 * A cheap test for "this is worth walking a fiber tree over".
 *
 * The walk climbs to the React root and searches the whole tree, which is not
 * something to do on every DOM mutation in the Steam client. A context menu
 * always brings Steam's own contextmenu classes with it.
 */
function looksLikeMenu(node: Element): boolean {
  const className = typeof node.className === "string" ? node.className : "";
  return /contextmenu/i.test(className) || node.querySelector('[class*="ontextMenu"]') !== null;
}

export function register() {
  let unpatch: (() => void) | undefined;
  let missed = false;
  const observers: MutationObserver[] = [];

  function capture(root: Element | undefined, retries = 3) {
    if (unpatch || !root || !looksLikeMenu(root)) return;

    const instance = findManageMenu(root);
    if (!instance) {
      // The menu's nodes land in the DOM a commit before its class shows up in
      // the fiber tree, and once the menu has finished opening there are no
      // more mutations to try again on. So the retries are the difference
      // between catching this menu and waiting for the next one.
      if (retries > 0) {
        setTimeout(() => capture(root, retries - 1), 100);
        return;
      }

      // Every context menu comes through here, most of them not an app's, so
      // this is only worth saying once - and it's the difference between the
      // class having moved and the item being suppressed for this game.
      if (!missed) {
        missed = true;
        logger.debug("Saw a context menu with no app actions in it");
      }
      return;
    }

    unpatch = patchPrototype(instance);
    logger.debug("Patched the manage menu");

    // The menu that handed us the prototype was built before the patch
    // existed, so it would be the one menu without our item in it.
    instance.forceUpdate();

    for (const observer of observers) observer.disconnect();
    observers.length = 0;
  }

  // A context menu is a popup only when Steam is asked for one; by default it
  // renders into the window it was opened from. So both are watched, and both
  // stop mattering the moment one of them finds the class.
  function observe(root: Element | undefined) {
    if (!root) return undefined;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          // `node instanceof Element` is always false here. The menu belongs to
          // the window it opened in, and that's a different realm from the one
          // the plugin runs in, so its nodes fail every cross-realm instanceof.
          if (node.nodeType === 1) capture(node as Element);
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

  observe(Steam.MainPopup?.root_element);

  // Every popup, whatever it says it is: a context menu window is empty at
  // create time, so the observer is the thing that actually finds the menu, and
  // the immediate attempt only ever pays off for one that's already rendered.
  const unwatch = onPopupCreate((popup, _type, handlers) => {
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
