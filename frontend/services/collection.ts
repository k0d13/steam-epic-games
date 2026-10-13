import { type SteamAppOverview } from "millennium";
import * as appIds from "../state/app-ids";

// Every Epic shortcut in one manual Steam collection. The collection API is untyped
// and not on every build, so every call is feature tested.

export const COLLECTION_NAME = "Epic Games";

interface DragDropCollection {
  AddApps(apps: SteamAppOverview[]): void;
}

interface Collection {
  id: string;
  displayName: string;
  allApps: SteamAppOverview[];
  AsDragDropCollection?(): DragDropCollection | undefined;
  Save?(): Promise<unknown> | void;
}

interface Collections {
  userCollections?: Collection[];
  NewUnsavedCollection?(
    name: string,
    source: Collection | undefined,
    apps: SteamAppOverview[],
  ): Collection | undefined;
}

const collections = () => collectionStore as unknown as Collections;

function findCollection(): Collection | undefined {
  return collections().userCollections?.find(
    (collection) => collection.displayName === COLLECTION_NAME,
  );
}

/** The overviews behind our shortcuts, skipping any Steam doesn't know about. */
function overviews(games: EpicGame[]): SteamAppOverview[] {
  const wanted = new Set<number>();

  for (const game of games) {
    const appId = appIds.getAppId(game.app_name);
    if (appId !== undefined) wanted.add(appId);
  }

  return appStore.allApps.filter((app) => wanted.has(app.appid));
}

/** Our shortcuts the collection doesn't hold yet. */
function missingFrom(collection: Collection, apps: SteamAppOverview[]) {
  const present = new Set(collection.allApps.map((app) => app.appid));
  return apps.filter((app) => !present.has(app.appid));
}

type CollectionResult =
  /** `added` by this call, and the `total` of ours in the collection after it. */
  { ok: true; added: number; total: number } | { ok: false; error: string };

/**
 * Add every Epic shortcut to the collection, creating it if needed. Only ever adds,
 * so games dragged in by hand stay.
 */
export async function addAll(games: EpicGame[]): Promise<CollectionResult> {
  const apps = overviews(games);
  if (apps.length === 0) {
    return { ok: false, error: "No Epic shortcuts to collect yet." };
  }

  const existing = findCollection();

  if (!existing) {
    const created = collections().NewUnsavedCollection?.(COLLECTION_NAME, undefined, apps);
    if (!created?.Save) {
      console.warn("This Steam build exposes no way to create a collection");
      return { ok: false, error: "Steam wouldn't create the collection." };
    }

    await created.Save();
    console.info("Created the Epic Games collection", { apps: apps.length });
    return { ok: true, added: apps.length, total: apps.length };
  }

  // A filter-based collection has no app list, and we won't overwrite the user's filter.
  const editable = existing.AsDragDropCollection?.();
  if (!editable || !existing.Save) {
    console.warn("The Epic Games collection isn't one we can add to", { id: existing.id });
    return {
      ok: false,
      error: `A collection named "${COLLECTION_NAME}" already exists and can't be edited.`,
    };
  }

  const missing = missingFrom(existing, apps);

  if (missing.length > 0) {
    editable.AddApps(missing);
    await existing.Save();
  }

  console.info("Filled the Epic Games collection", { added: missing.length, total: apps.length });
  return { ok: true, added: missing.length, total: apps.length };
}

/** How many of our shortcuts are missing from the collection. */
export function missingCount(games: EpicGame[]): number {
  const apps = overviews(games);
  const existing = findCollection();
  return existing ? missingFrom(existing, apps).length : apps.length;
}
