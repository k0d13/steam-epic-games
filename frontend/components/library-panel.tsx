import {
  DialogButton,
  Field,
  Menu,
  MenuItem,
  MenuSeparator,
  ProgressBarWithInfo,
  showContextMenu,
} from "@steambrew/client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { logger } from "../index";
import { type EpicGame } from "../rpc";
import * as artwork from "../services/artwork";
import * as hidden from "../services/hidden";
import * as shortcuts from "../services/shortcuts";
import * as library from "../state/library";

// Two rows, one button each - the panel is too narrow for more. Everything past
// the primary action lives in the context menu that button opens.

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

/** Describe a finished sync, for a panel that may not have been open for it. */
function describeResult(result: shortcuts.SyncResult) {
  return (
    `Added ${result.added}, removed ${result.removed}, ${result.artworkApplied} images` +
    (result.failed ? `, ${result.failed} failed` : "")
  );
}

export function LibraryPanel() {
  const [games, setGames] = useState<EpicGame[] | undefined>(undefined);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [synced, setSynced] = useState(0);
  const [note, setNote] = useState<string | undefined>(undefined);

  // A sync outlives this panel, so its progress is read from the service:
  // closing the dialog mid-sync must not lose the bar.
  const sync = useSyncExternalStore(shortcuts.subscribeToSync, shortcuts.getSyncState);

  const load = useCallback(async (refresh: boolean): Promise<number | undefined> => {
    setLoading(true);
    setError(undefined);

    // Only the call is guarded, or a failure anywhere in the UI would be
    // reported as the backend not responding.
    let result;
    try {
      // `force` too: the reason to press Refresh is a change at Epic's end
      // that legendary's catalog cache would miss.
      result = await library.load(refresh, refresh);
    } catch (reason: unknown) {
      logger.warn("GetLibrary failed", reason);
      setError("The plugin's backend didn't respond.");
      setLoading(false);
      return;
    }

    if (!result.ok) {
      setError(result.error ?? "Couldn't read your library");
    } else {
      setGames(result.games);
      setRefreshedAt(result.refreshedAt);
      setSynced(shortcuts.syncedCount(result.games));
    }

    setLoading(false);
    return result.ok ? result.refreshedAt : undefined;
  }, []);

  useEffect(() => {
    // Nothing goes out to Epic on its own, so a first run has an empty cache -
    // and this is the one place with a panel on screen to say so.
    void load(false).then((loaded) => {
      if (loaded === 0) void load(true);
    });
  }, [load]);

  const onSync = useCallback(async () => {
    if (!games) return;

    setNote(undefined);

    // The service owns the progress and the result, since both have to survive
    // this panel closing.
    await shortcuts.sync(games);
    setSynced(shortcuts.syncedCount(games));
  }, [games]);

  const onManage = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Counted as the menu opens: hiding a game anywhere else in Steam changes
      // both of these without the panel hearing about it.
      const hideable = games ? hidden.hideableCount(games) : 0;
      const alreadyHidden = hidden.hiddenCount();

      showContextMenu(
        <Menu label="Steam shortcuts">
          <MenuItem onSelected={() => void onSync()}>Sync now</MenuItem>
          <MenuItem
            onSelected={() => {
              artwork.forgetAll();
              setNote("Artwork cleared. Sync again to fetch it.");
            }}
          >
            Redownload artwork
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={hideable === 0}
            onSelected={() => {
              if (!games) return;
              const count = hidden.hideDuplicates(games);
              setNote(
                count > 0
                  ? `Hid ${count} game${count === 1 ? "" : "s"} you also own on Steam.`
                  : "Nothing to hide.",
              );
            }}
          >
            {hideable > 0 ? `Hide ${hideable} duplicates of Steam games` : "No duplicates to hide"}
          </MenuItem>
          <MenuItem
            disabled={alreadyHidden === 0}
            onSelected={() => {
              const count = hidden.showAll();
              setNote(`Unhid ${count} game${count === 1 ? "" : "s"}.`);
            }}
          >
            Show all hidden Epic games
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            tone="destructive"
            onSelected={() => {
              shortcuts.removeAll();
              library.reindexAppIds();
              setSynced(0);
              setNote("Removed every shortcut this plugin created.");
            }}
          >
            Remove all shortcuts
          </MenuItem>
        </Menu>,
        event.currentTarget ?? undefined,
      );
    },
    [onSync, games],
  );

  // A sync that finished while this panel was closed still has to update the
  // count it's showing.
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
            : `${total} games, ${installed} installed - ${describeAge(refreshedAt)}`)
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
          // In place of the description rather than a row of its own, which
          // would overrun the panel.
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
                ? `All ${total} games are in your Steam library.`
                : `${synced} of ${total} games are in your Steam library.`))
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
