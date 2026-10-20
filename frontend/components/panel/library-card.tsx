import { ConfirmModal, DialogButton, showModal } from "millennium";
import { type LibraryView } from "../../hooks/use-library";
import { mainPopup } from "../../services/steam/popups";
import { type LoadResult, loadAll } from "../../services/sync/caches";
import { sync } from "../../services/sync/sync";
import * as preferences from "../../state/preferences";
import { useValue } from "../../state/primitives";
import { type SyncResult, progress } from "../../state/sync-progress";
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
  const read = `Read the details of ${plural(result.loaded, "game")}.`;
  if (result.failed === 0) return { text: read };
  return { text: `${read} ${result.failed} couldn't be read; try again later.`, error: true };
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
  // A clean up only disables the buttons, and its progress is in the Maintenance card
  const syncing = state.active && state.operation === "sync";
  const reading = state.active && state.operation === "load";

  const total = games?.length ?? 0;
  const busy = loading || state.active;
  const action = describeAction(syncing, synced, total);

  const shown = error
    ? { text: error, error: true }
    : (message ??
      (state.active || !state.lastResult ? undefined : describeResult(state.lastResult)));

  function onSync() {
    if (!games) return;
    setMessage(undefined);
    // The service owns progress and result so they survive the dialog closing
    void sync(games);
  }

  function confirmLoad() {
    if (!games) return;
    const withInfo = preferences.get().gameInfo;

    showModal(
      <ConfirmModal
        strTitle="Read every game's details?"
        strDescription={
          `Reads ${withInfo ? "info and achievements" : "achievements"} for all ` +
          `${plural(games.length, "game")} from Epic${withInfo ? " and egdata" : ""}, one at a ` +
          "time. This can take a long while, but you can keep using Steam meanwhile. " +
          "Games that already have details are skipped, so it's safe to run again" +
          (withInfo ? "" : ". Turn on Show game info first to read the rest too.")
        }
        strOKButtonText="Read"
        onOK={() => {
          setMessage(undefined);
          void loadAll(games).then((result) => result && setMessage(describeLoad(result)));
        }}
      />,
      // Explicit because showModal's default, findSP(), throws on this build
      mainPopup()?.window,
    );
  }

  return (
    <Card>
      <Identity
        initial={name.charAt(0).toUpperCase() || "E"}
        title={name}
        subtitle={describeLibrary(games, refreshedAt)}
      />
      {syncing ? (
        <Meter
          label={state.total ? "Adding to Steam" : "Checking your Steam library…"}
          done={state.done}
          total={state.total}
        />
      ) : (
        total > 0 && (
          <Meter
            label={synced === 0 ? "Not in Steam yet" : "In your Steam library"}
            done={synced}
            total={total}
          />
        )
      )}
      <MessageLine message={shown} />
      <Actions>
        <DialogButton className="epic-grow" disabled={busy || total === 0} onClick={onSync}>
          {syncing ? <Busy>{action}</Busy> : action}
        </DialogButton>
        <DialogButton className="epic-fixed" disabled={busy} onClick={refresh}>
          {loading ? <Busy>Checking</Busy> : "Refresh"}
        </DialogButton>
        <DialogButton className="epic-fixed" disabled={busy || total === 0} onClick={confirmLoad}>
          {reading ? <Busy>Reading</Busy> : "Read details"}
        </DialogButton>
      </Actions>
    </Card>
  );
}
