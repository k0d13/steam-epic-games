import { ConfirmModal, DialogButton, showModal } from "millennium";
import { mainPopup } from "../../services/steam/popups";
import { type LoadResult, loadAll } from "../../services/sync/caches";
import { sync } from "../../services/sync/sync";
import * as preferences from "../../state/preferences";
import { useValue } from "../../state/primitives";
import { type SyncResult, type SyncState, progress } from "../../state/sync-progress";
import {
  Actions,
  Busy,
  Card,
  Identity,
  type Message,
  MessageLine,
  Meter,
  plural,
} from "../ui/primitives";
import { type LibraryView } from "./use-library";

// Roughly, which is close enough to answer "is this stale?"
function describeAge(refreshedAt: number) {
  if (!refreshedAt) return "never checked";

  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - refreshedAt);
  if (seconds < 60) return "checked just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `checked ${hours}h ago`;

  return `checked ${Math.floor(hours / 24)}d ago`;
}

// For a panel that may not have been open when the sync finished
function describeResult(result: SyncResult) {
  if (result.error) return { text: `Sync stopped partway: ${result.error}`, error: true };

  const parts = [
    result.added && `${result.added} added`,
    result.removed && `${result.removed} removed`,
    result.failed && `${result.failed} couldn't be added`,
  ].filter(Boolean);

  return parts.length > 0 ? { text: `Last sync: ${parts.join(", ")}.` } : undefined;
}

function describeLoad(result: LoadResult) {
  if (result.loaded + result.failed === 0) return { text: "Every game is already scanned." };

  const scanned = `Scanned ${plural(result.loaded, "game")}.`;
  if (result.failed === 0) return { text: scanned };
  return { text: `${scanned} ${result.failed} couldn't be read; scan again later.`, error: true };
}

function describeLibrary(games: EpicGame[] | undefined, refreshedAt: number) {
  if (games === undefined) return "Reading your library…";
  if (games.length === 0) return "No games yet";

  const installed = games.filter((game) => game.installed).length;
  return `${plural(games.length, "game")} · ${installed} installed · ${describeAge(refreshedAt)}`;
}

function describeAction(syncing: boolean, synced: number, total: number) {
  if (syncing) return "Syncing";
  if (synced === 0) return "Add to Steam";
  if (synced < total) return `Add ${total - synced} more`;
  return "Sync now";
}

function describeMeter(state: SyncState, synced: number, total: number) {
  if (state.active && state.operation === "sync") {
    const label = state.total ? "Adding to Steam" : "Checking your Steam library…";
    return { label, done: state.done, total: state.total };
  }
  if (state.active && state.operation === "load") {
    return { label: "Scanning games", done: state.done, total: state.total };
  }
  if (total === 0) return undefined;

  return {
    label: synced === 0 ? "Not in Steam yet" : "In your Steam library",
    done: synced,
    total,
  };
}

function describeScan(withInfo: boolean) {
  return (
    `Reads ${withInfo ? "info and achievements" : "achievements"} from Epic` +
    `${withInfo ? " and egdata" : ""} for the games that don't have them yet, so the ` +
    "library's filters and collections know about every game. One game at a time, so " +
    "it can take a long while, but you can keep using Steam meanwhile, and a game " +
    "scanned already is skipped" +
    (withInfo ? "." : ". Turn on Show game info first to read the rest too.")
  );
}

function describeLast(state: SyncState) {
  return state.active || !state.lastResult ? undefined : describeResult(state.lastResult);
}

function confirmLoad(games: EpicGame[], setMessage: (message: Message | undefined) => void) {
  showModal(
    <ConfirmModal
      strTitle="Scan every game?"
      strDescription={describeScan(preferences.get().gameInfo)}
      strOKButtonText="Scan"
      onOK={() => {
        setMessage(undefined);
        void loadAll(games).then((result) => result && setMessage(describeLoad(result)));
      }}
    />,
    // Explicit because showModal's default, findSP(), throws on this build
    mainPopup()?.window,
  );
}

export function LibraryCard({
  name,
  view,
  message,
  setMessage,
}: {
  name: string;
  view: LibraryView;
  message: Message | undefined;
  setMessage(message: Message | undefined): void;
}) {
  const { games, refreshedAt, loading, error, synced, refresh } = view;
  const state = useValue(progress);
  // A clean up only disables the buttons, and its progress is in the Maintenance card;
  // a sync and a scan take this card's meter while they run
  const syncing = state.active && state.operation === "sync";
  const scanning = state.active && state.operation === "load";

  const total = games?.length ?? 0;
  const busy = loading || state.active;
  const action = describeAction(syncing, synced, total);
  const meter = describeMeter(state, synced, total);

  const shown = error ? { text: error, error: true } : (message ?? describeLast(state));

  function onSync() {
    if (!games) return;
    setMessage(undefined);
    // The service owns progress and result so they survive the dialog closing
    void sync(games);
  }

  return (
    <Card>
      <Identity
        initial={name.charAt(0).toUpperCase() || "E"}
        title={name}
        subtitle={describeLibrary(games, refreshedAt)}
      />
      {meter && <Meter {...meter} />}
      <MessageLine message={shown} />
      <Actions>
        <DialogButton className="epic-wide" disabled={busy || total === 0} onClick={onSync}>
          {syncing ? <Busy>{action}</Busy> : action}
        </DialogButton>
        <DialogButton disabled={busy} onClick={refresh}>
          {loading ? <Busy>Checking</Busy> : "Refresh"}
        </DialogButton>
        <DialogButton
          disabled={busy || total === 0}
          onClick={() => games && confirmLoad(games, setMessage)}
        >
          {scanning ? <Busy>Scanning</Busy> : "Scan games"}
        </DialogButton>
      </Actions>
    </Card>
  );
}
