import { Steam } from "steambrew-utils";
import { logger } from "../index";
import { type EpicGame } from "../rpc";
import * as appIds from "../state/app-ids";

// Every Epic shortcut in one Steam collection, so the library has an "Epic
// Games" shelf without us drawing one.
//
// Collections are Steam's own, stored in cloud storage and edited through the
// collection store: a manual ("drag drop") collection holds an explicit list of
// apps, which is what this builds. None of it is in steambrew-utils' types and
// none of it is guaranteed to exist on a given client build, so every call is
// feature tested and a missing one costs only this feature.

export const COLLECTION_NAME = "Epic Games";

interface DragDropCollection {
  AddApps(apps: Steam.AppOverview[]): void;
}

interface Collection {
  id: string;
  displayName: string;
  allApps: Steam.AppOverview[];
  AsDragDropCollection?(): DragDropCollection | undefined;
  Save?(): Promise<unknown> | void;
}

interface Collections {
  userCollections?: Collection[];
  NewUnsavedCollection?(
    name: string,
    source: Collection | undefined,
    apps: Steam.AppOverview[],
  ): Collection | undefined;
}

const collections = () => Steam.CollectionStore as unknown as Collections;

function findCollection(): Collection | undefined {
  return collections().userCollections?.find(
    (collection) => collection.displayName === COLLECTION_NAME,
  );
}

/** The overviews behind our shortcuts, skipping any Steam doesn't know about. */
function overviews(games: EpicGame[]): Steam.AppOverview[] {
  const wanted = new Set<number>();

  for (const game of games) {
    const appId = appIds.getAppId(game.appName);
    if (appId !== undefined) wanted.add(appId);
  }

  return Steam.AppStore.allApps.filter((app) => wanted.has(app.appid));
}

export interface CollectionResult {
  ok: boolean;
  /** Games added by this call, not the collection's total. */
  added: number;
  /** Everything of ours in the collection once this finished. */
  total: number;
  error?: string;
}

/**
 * Put every Epic game with a shortcut into the collection, creating it if it
 * isn't there. Re-running it adds only what's missing, and nothing is ever
 * removed - a game dragged in by hand stays.
 */
export async function addAll(games: EpicGame[]): Promise<CollectionResult> {
  const apps = overviews(games);
  if (apps.length === 0) {
    return { ok: false, added: 0, total: 0, error: "No Epic shortcuts to collect yet." };
  }

  const existing = findCollection();

  // A new collection is created with its apps in one go; an existing one is
  // only ever added to.
  if (!existing) {
    const created = collections().NewUnsavedCollection?.(COLLECTION_NAME, undefined, apps);
    if (!created?.Save) {
      logger.warn("This Steam build exposes no way to create a collection");
      return { ok: false, added: 0, total: 0, error: "Steam wouldn't create the collection." };
    }

    await created.Save();
    logger.info("Created the Epic Games collection", { apps: apps.length });
    return { ok: true, added: apps.length, total: apps.length };
  }

  // A dynamic collection - one built from a filter - has no app list to write
  // to, and overwriting the user's filter would be worse than doing nothing.
  const editable = existing.AsDragDropCollection?.();
  if (!editable || !existing.Save) {
    logger.warn("The Epic Games collection isn't one we can add to", { id: existing.id });
    return {
      ok: false,
      added: 0,
      total: 0,
      error: `A collection named "${COLLECTION_NAME}" already exists and can't be edited.`,
    };
  }

  const present = new Set(existing.allApps?.map((app) => app.appid) ?? []);
  const missing = apps.filter((app) => !present.has(app.appid));

  if (missing.length > 0) {
    editable.AddApps(missing);
    await existing.Save();
  }

  logger.info("Filled the Epic Games collection", { added: missing.length, total: apps.length });
  return { ok: true, added: missing.length, total: apps.length };
}

/** How many of our shortcuts are missing from the collection. */
export function missingCount(games: EpicGame[]): number {
  const apps = overviews(games);
  const existing = findCollection();
  if (!existing) return apps.length;

  const present = new Set(existing.allApps?.map((app) => app.appid) ?? []);
  return apps.filter((app) => !present.has(app.appid)).length;
}
