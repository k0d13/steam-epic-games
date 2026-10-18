import * as appIds from "../state/app-ids";

// Every Epic shortcut in one manual Steam collection.

export const COLLECTION_NAME = "Epic Games";

const findCollection = () =>
  collectionStore.userCollections.find((collection) => collection.displayName === COLLECTION_NAME);

/**
 * Add every Epic shortcut to the collection, creating it if needed. Only ever adds,
 * so games dragged in by hand stay. Returns why it couldn't, if it couldn't.
 */
export async function addAll(games: EpicGame[]): Promise<string | undefined> {
  const wanted = new Set(games.map((game) => appIds.getAppId(game.app_name)));
  const apps = appStore.allApps.filter((app) => wanted.has(app.appid));
  if (apps.length === 0) return "No Epic shortcuts to collect yet.";

  const existing = findCollection();
  if (!existing) {
    await collectionStore.NewUnsavedCollection(COLLECTION_NAME, undefined, apps).Save();
    console.info("Created the Epic Games collection", { apps: apps.length });
    return undefined;
  }

  // A filter-based collection has no app list, and we won't overwrite the user's filter.
  const editable = existing.AsDragDropCollection();
  if (!editable)
    return `A collection named "${COLLECTION_NAME}" already exists and can't be edited.`;

  const present = new Set(existing.allApps.map((app) => app.appid));
  const missing = apps.filter((app) => !present.has(app.appid));
  if (missing.length === 0) return undefined;

  editable.AddApps(missing);
  await existing.Save();
  console.info("Filled the Epic Games collection", { added: missing.length });
  return undefined;
}

/**
 * Delete the collection, unless it holds anything besides the shortcuts in
 * `removing`: a game dragged in by hand means the user made it theirs.
 */
export async function removeIfEmpty(removing: Set<number>) {
  const existing = findCollection();
  // Steam drops removed shortcuts from the collection a beat later, so they count as gone.
  if (!existing || existing.allApps.some((app) => !removing.has(app.appid))) return;

  await existing.Delete().catch((reason: unknown) => {
    console.warn("Could not delete the Epic Games collection", reason);
  });
}
