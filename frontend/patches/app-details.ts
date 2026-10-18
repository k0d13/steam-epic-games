import { type AppDetails, callOriginal, replacePatch } from "millennium";
import * as jobs from "../state/jobs";
import * as library from "../state/library";
import * as sizes from "../state/sizes";
import { getAchievements } from "./achievements";

// "Space Required" reads `bHasAnyLocalContent` and `lDiskSpaceRequiredBytes`, which
// shortcuts get wrong. AppDetailsChanged is a non-writable mobx action, so we patch its callback.

/**
 * Rewrite one app's details to match Epic. An install in progress counts as
 * installed, so the play bar doesn't shift under the cursor as progress appears.
 */
function apply(details: AppDetails) {
  const game = library.getByAppId(details.unAppID);
  if (!game) return;

  // Epic keeps achievements per account, so uninstalled games show them too. Left
  // alone while waiting, so the section doesn't flicker.
  const achievements = getAchievements(game.app_name);
  if (achievements) details.achievements = achievements;

  if (game.installed) return;

  // Any state: a finished install is on disk a poll before the library knows.
  details.bHasAnyLocalContent = jobs.get(game.app_name)?.kind === "install";
  if (details.bHasAnyLocalContent) return;

  const size = sizes.get(game.app_name);
  if (size) details.lDiskSpaceRequiredBytes = size.disk;
  // Fetches the manifest from Epic, so it's drawn on a later pass.
  else sizes.ensure(game.app_name);
}

/** Set while registering a read that must see Steam's own details. */
let unpatched = false;

/**
 * Register for an app's details without our edits. Every patched read starts a
 * size and achievements fetch, each a legendary run, which a scan of every
 * shortcut would queue hundreds of ahead of everything else.
 */
export function registerUnpatched(
  ...args: Parameters<typeof SteamClient.Apps.RegisterForAppDetails>
): ReturnType<typeof SteamClient.Apps.RegisterForAppDetails> {
  unpatched = true;
  try {
    return SteamClient.Apps.RegisterForAppDetails(...args);
  } finally {
    unpatched = false;
  }
}

export function register() {
  // replacePatch, so our wrapper can replace the callback argument.
  const patch = replacePatch(SteamClient.Apps, "RegisterForAppDetails", (args) => {
    const [, callback] = args;
    if (!unpatched) {
      args[1] = (details) => {
        apply(details);
        callback(details);
      };
    }

    // Forwards with the edited arguments.
    return callOriginal as never;
  });

  // A size arriving is asynchronous and has no other way back into the UI.
  const unsubscribe = sizes.subscribe(refreshAll);

  return () => {
    patch.unpatch();
    unsubscribe();
  };
}

/** What we last sent for an app, so an unchanged pass costs no re-render. */
const applied = new Map<number, string>();

/**
 * Correct the details Steam already holds through AppDetailsChanged. A copy, or
 * observers see the same reference and don't re-render.
 */
export function refreshAll() {
  const store = Reflect.get(globalThis, "appDetailsStore") as
    | {
        m_mapAppData: Map<number, { details?: AppDetails }>;
        /** Callable, but not patchable - see above. */
        AppDetailsChanged(details: AppDetails): void;
      }
    | undefined;
  if (!store) return;

  for (const { details } of store.m_mapAppData.values()) {
    if (!details || library.getByAppId(details.unAppID) === undefined) continue;

    const updated = { ...details };
    apply(updated);

    // Only when changed since we last sent it, as this runs on every jobs poll.
    const signature = [
      updated.bHasAnyLocalContent,
      updated.lDiskSpaceRequiredBytes,
      updated.achievements?.nAchieved,
      updated.achievements?.nTotal,
    ].join("|");
    if (applied.get(details.unAppID) === signature) continue;

    applied.set(details.unAppID, signature);
    store.AppDetailsChanged(updated);
  }
}
