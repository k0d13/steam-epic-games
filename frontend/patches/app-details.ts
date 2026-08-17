import { callOriginal, replacePatch } from "@steambrew/client";
import { logger } from "../index";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import * as sizes from "../state/sizes";

// Steam's play bar shows "Space Required" beside Install for a game that isn't
// on disk yet, and drops it once the install starts - which is what stops the
// bar shifting under the cursor. It isn't a component to replace, it's two
// fields on the app's details:
//
//   !details.bHasAnyLocalContent && details.lDiskSpaceRequiredBytes
//     ? <SectionItem label="#AppDetails_SectionTitle_DiskSpaceRequired">...
//     : null
//
// A shortcut points at a file on disk, so Steam reports local content for every
// Epic game and neither field is ever right. Correcting them on the way in gets
// the row rendered, laid out and dismissed by Steam itself.
//
// The obvious place to do that is appDetailsStore.AppDetailsChanged, where every
// update lands. It can't be patched: it's a mobx action, and mobx 6 defines
// those as non-writable, so assigning over it throws "Cannot assign to read only
// property". So we go one step earlier, to the client callback the store
// registers - a plain object property, and the same thing every update arrives
// through anyway.

/** Only the fields we touch; details carry several dozen we don't. */
interface AppDetails {
  unAppID: number;
  bHasAnyLocalContent?: boolean;
  lDiskSpaceRequiredBytes?: number;
}

interface AppData {
  details?: AppDetails;
}

interface AppDetailsStore {
  /** Where every details update lands. Callable, but not patchable - see above. */
  AppDetailsChanged(details: AppDetails): void;
  m_mapAppData: Map<number, AppData>;
}

type DetailsCallback = (details: AppDetails) => void;

interface AppsApi extends Record<PropertyKey, unknown> {
  RegisterForAppDetails(appId: number, callback: DetailsCallback): { unregister(): void };
}

function getStore(): AppDetailsStore | undefined {
  return Reflect.get(globalThis, "appDetailsStore") as AppDetailsStore | undefined;
}

function getApps(): AppsApi {
  return SteamClient.Apps as unknown as AppsApi;
}

let verified = false;

/**
 * Rewrite one app's details to match what Epic says. Installed games are left
 * alone: Steam's own answer for them is already "there is content on disk",
 * which is true, and the row is meant to be hidden then anyway.
 *
 * A game part-way through an install counts as installed for this purpose.
 * Steam drops the row the moment its own download starts - bytes on disk are
 * local content - and that's what stops the play bar shifting under the cursor
 * as the progress bar appears.
 */
function apply(details: AppDetails) {
  const game = library.getByAppId(details.unAppID);
  if (!game || game.installed) return;

  // Written, not skipped: refreshAll re-applies to details we already corrected,
  // so leaving the field alone would leave our own `false` in place.
  const job = jobs.get(game.appName);
  if (job?.kind === "install" && (job.state === "running" || job.state === "paused")) {
    details.bHasAnyLocalContent = true;
    return;
  }

  details.bHasAnyLocalContent = false;

  const size = sizes.get(game.appName);
  if (size) details.lDiskSpaceRequiredBytes = size.disk;
  // Reading it means fetching this game's manifest from Epic, so it's started
  // here and drawn on the pass after it lands.
  else sizes.ensure(game.appName);

  if (!verified) {
    verified = true;
    logger.debug("App details patch applied", {
      appId: details.unAppID,
      appName: game.appName,
      // If these come back as anything else, the fields are read-only or renamed
      // on this Steam build and none of this is having any effect.
      gotLocalContent: details.bHasAnyLocalContent,
      gotRequired: details.lDiskSpaceRequiredBytes,
    });
  }
}

export function register() {
  // replacePatch rather than beforePatch because the point is to swap out an
  // argument: `args` is the array the original is then called with, so putting
  // our wrapper in it is what gets us in front of every update for this app.
  const patch = replacePatch(getApps(), "RegisterForAppDetails", (args) => {
    const [, callback] = args as [number, DetailsCallback];

    args[1] = (details: AppDetails) => {
      apply(details);
      callback(details);
    };

    // Forwards to the real function with the arguments we just edited. The cast
    // is replacePatch's typing being narrower than it is: its handler is only
    // described as returning what the patched function returns.
    return callOriginal as unknown as ReturnType<AppsApi["RegisterForAppDetails"]>;
  });

  // A size arriving is asynchronous and has no other way back into the UI.
  const unsubscribe = sizes.subscribe(() => refreshAll());

  logger.debug("Registered the app details patch");

  return () => {
    patch.unpatch();
    unsubscribe();
  };
}

/**
 * Correct the details Steam is already holding, and get them re-read.
 *
 * AppDetailsChanged can't be patched but it can be called, and it's the store's
 * own inbound path for one plain object: it stores what we hand it and then
 * notifies the same listeners the client's own updates do.
 *
 * It has to be a copy. The store holds details by reference, so re-submitting
 * the same object leaves that reference unchanged and the observers watching it
 * have no reason to re-render - the corrected fields would sit there unread
 * until something else happened to repaint the page.
 */
export function refreshAll() {
  const store = getStore();
  if (!store) return;

  for (const data of store.m_mapAppData.values()) {
    const details = data.details;
    if (!details || library.getByAppId(details.unAppID) === undefined) continue;

    const updated = { ...details };
    apply(updated);
    store.AppDetailsChanged(updated);
  }
}
