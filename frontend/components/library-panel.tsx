import {
  ConfirmModal,
  DialogButton,
  Field,
  Menu,
  MenuItem,
  MenuSeparator,
  ProgressBarWithInfo,
  showContextMenu,
  showModal,
} from "millennium";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as artwork from "../services/artwork";
import * as collection from "../services/collection";
import * as hidden from "../services/hidden";
import { mainPopup } from "../services/popups";
import * as shortcuts from "../services/shortcuts";
import * as library from "../state/library";

// The panel only fits one button per row; the rest live in the context menu.

/** "3 hours ago", roughly - close enough to answer "is this stale?". */
function describeAge(refreshedAt: number) {
  if (!refreshedAt) return "never refreshed";

  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - refreshedAt);
  if (seconds < 60) return "updated just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;

  return `updated ${Math.floor(hours / 24)}d ago`;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Describe a finished sync, for a panel that may not have been open for it. */
function describeResult(result: shortcuts.SyncResult) {
  const counts =
    `added ${result.added}, removed ${result.removed}, ${plural(result.artworkApplied, "image")}` +
    (result.failed ? `, ${result.failed} failed` : "");

  // The counts alone would read as a finished sync.
  if (result.error) return `Sync stopped partway (${counts}): ${result.error}`;
  return counts.charAt(0).toUpperCase() + counts.slice(1);
}

export function LibraryPanel() {
  const [games, setGames] = useState<EpicGame[] | undefined>(undefined);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [synced, setSynced] = useState(0);
  const [note, setNote] = useState<string | undefined>(undefined);

  // Read from the service so closing the dialog mid-sync doesn't lose the bar.
  const sync = useSyncExternalStore(shortcuts.subscribeToSync, shortcuts.getSyncState);

  const load = useCallback(async (refresh: boolean): Promise<number | undefined> => {
    setLoading(true);
    setError(undefined);

    // Only the call is guarded, so UI errors aren't blamed on the backend.
    let result;
    try {
      // `force` too: Refresh is for changes legendary's catalog cache would miss.
      result = await library.load(refresh, refresh);
    } catch (reason: unknown) {
      console.warn("get_library failed", reason);
      setError("The plugin's backend didn't respond.");
      setLoading(false);
      return;
    }

    setError(result.error ?? undefined);
    setGames(result.games);
    setRefreshedAt(result.refreshed_at);
    setSynced(shortcuts.syncedCount(result.games));

    setLoading(false);
    return result.error ? undefined : result.refreshed_at;
  }, []);

  useEffect(() => {
    // Nothing asks Epic on its own, so a first run fetches here.
    void load(false).then((loaded) => {
      if (loaded === 0) void load(true);
    });
  }, [load]);

  const onSync = useCallback(async () => {
    if (!games) return;

    setNote(undefined);

    // The service owns progress and result so they survive the panel closing.
    await shortcuts.sync(games);
    setSynced(shortcuts.syncedCount(games));
  }, [games]);

  const onManage = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Counted on open: hiding elsewhere in Steam changes these unannounced.
      const hideable = games ? hidden.hideableCount(games) : 0;
      const alreadyHidden = hidden.hiddenCount();
      const uncollected = games ? collection.missingCount(games) : 0;

      showContextMenu(
        <Menu label="Steam shortcuts">
          <MenuItem onSelected={() => void onSync()}>Sync now</MenuItem>
          <MenuItem
            onSelected={() => {
              artwork.forgetAll();
              void onSync();
            }}
          >
            Redownload artwork
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelected={() => {
              if (!games) return;
              void collection.addAll(games).then((result) => {
                if (!result.ok) {
                  setNote(result.error);
                } else if (result.added > 0) {
                  setNote(
                    `Added ${result.added} to the "${collection.COLLECTION_NAME}" collection.`,
                  );
                } else {
                  setNote(
                    result.total === 1
                      ? `Your game is already in "${collection.COLLECTION_NAME}".`
                      : `All ${result.total} games are already in "${collection.COLLECTION_NAME}".`,
                  );
                }
              });
            }}
          >
            {uncollected > 0
              ? `Add ${plural(uncollected, "game")} to an "${collection.COLLECTION_NAME}" collection`
              : `"${collection.COLLECTION_NAME}" collection is up to date`}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={hideable === 0}
            onSelected={() => {
              if (!games) return;
              const count = hidden.hideDuplicates(games);
              setNote(
                count > 0
                  ? `Hid ${plural(count, "game")} you also own on Steam.`
                  : "Nothing to hide.",
              );
            }}
          >
            {hideable > 0
              ? `Hide ${plural(hideable, "duplicate")} of Steam games`
              : "No duplicates to hide"}
          </MenuItem>
          <MenuItem
            disabled={alreadyHidden === 0}
            onSelected={() => {
              const count = hidden.showAll();
              setNote(`Unhid ${plural(count, "game")}.`);
            }}
          >
            Show all hidden Epic games
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            tone="destructive"
            // Confirmed: it's last in a gamepad-driven menu and only a full sync undoes it.
            onSelected={() =>
              showModal(
                <ConfirmModal
                  strTitle="Remove all shortcuts"
                  strDescription={
                    "This removes every Epic game this plugin added to your Steam library. " +
                    "Installed games stay on disk, and Add to Steam brings them back."
                  }
                  strOKButtonText="Remove all"
                  bDestructiveWarning
                  onOK={() => {
                    shortcuts.removeAll();
                    library.reindexAppIds();
                    setSynced(0);
                    setNote("Removed every shortcut this plugin created.");
                  }}
                />,
                // Explicit because showModal's default, findSP(), throws on this build.
                mainPopup()?.window,
              )
            }
          >
            Remove all shortcuts
          </MenuItem>
        </Menu>,
        event.currentTarget ?? undefined,
      );
    },
    [onSync, games],
  );

  // A sync that finished while the panel was closed still updates the count.
  useEffect(() => {
    if (sync.active || !games) return;
    setSynced(shortcuts.syncedCount(games));
  }, [sync.active, games]);

  const total = games?.length ?? 0;
  const installed = games?.filter((game) => game.installed).length ?? 0;
  const busy = loading || sync.active;

  return (
    <>
      <Field
        label="Epic library"
        description={
          error ??
          (games === undefined
            ? "Reading your library..."
            : `${plural(total, "game")}, ${installed} installed, ${describeAge(refreshedAt)}`)
        }
        childrenContainerWidth="min"
        bottomSeparator={total > 0 ? "standard" : "none"}
      >
        <DialogButton disabled={busy} onClick={() => void load(true)}>
          {loading ? "Refreshing..." : "Refresh"}
        </DialogButton>
      </Field>

      {total > 0 && (
        <Field
          label="Steam shortcuts"
          // In the description, since a row of its own would overrun the panel.
          description={
            sync.active ? (
              <ProgressBarWithInfo
                nProgress={sync.total ? (sync.done / sync.total) * 100 : 0}
                sOperationText={`Setting up ${sync.done} of ${sync.total}`}
              />
            ) : (
              (note ??
              (sync.lastResult && describeResult(sync.lastResult)) ??
              (synced === total
                ? total === 1
                  ? "Your game is in your Steam library."
                  : `All ${total} games are in your Steam library.`
                : `${synced} of ${plural(total, "game")} are in your Steam library.`))
            )
          }
          childrenContainerWidth="min"
          bottomSeparator="none"
        >
          <DialogButton disabled={busy} onClick={synced > 0 ? onManage : () => void onSync()}>
            {synced > 0 ? "Manage" : "Add to Steam"}
          </DialogButton>
        </Field>
      )}
    </>
  );
}
