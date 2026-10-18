import { DialogButton, Focusable } from "millennium";
import { useState, useSyncExternalStore } from "react";
import { open, SIGN_IN_URL } from "../patches/store-menu";
import * as steamLibrary from "../services/steam-library";
import * as account from "../state/account";
import { Identity, type Message, MessageLine, Meter, PANEL_CSS, plural } from "./panel-ui";
import { Maintenance, Options } from "./settings";
import { type LibraryView, useLibrary } from "./use-library";

// One status card, then the options and maintenance. Every operation reports on
// its card's one meter, so nothing shifts as it runs.

/** "2m ago", roughly - close enough to answer "is this stale?". */
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

/** A finished sync in a line, for a panel that may not have been open for it. */
function describeResult(result: steamLibrary.SyncResult): Message | undefined {
  if (result.error) return { text: `Sync stopped partway: ${result.error}`, error: true };

  const parts = [
    result.added && `${result.added} added`,
    result.removed && `${result.removed} removed`,
    result.failed && `${result.failed} couldn't be added`,
  ].filter(Boolean);

  return parts.length > 0 ? { text: `Last sync: ${parts.join(", ")}.` } : undefined;
}

/** The card for every state but signed in: connecting, unavailable, signed out. */
function AccountCard({ status }: { status: EpicStatus | undefined }) {
  const [retrying, setRetrying] = useState(false);

  // Forcing a status re-runs the download, for a machine that was offline.
  const onRetry = () => {
    setRetrying(true);
    backend
      .GetStatus(true)
      .catch((reason: unknown) => console.warn("GetStatus failed", reason))
      .finally(() => setRetrying(false));
  };

  if (!status) {
    return (
      <div className="epic-card">
        <Identity initial="…" title="Connecting to Epic" subtitle="Starting legendary" />
      </div>
    );
  }

  if (!status.available) {
    return (
      <div className="epic-card">
        <Identity initial="!" title="Can't reach Epic" subtitle="legendary isn't running" />
        <div className="epic-error">
          {status.error ?? "legendary couldn't be downloaded or run."}
        </div>
        <Focusable className="epic-actions" flow-children="horizontal">
          <DialogButton className="epic-grow" disabled={retrying} onClick={onRetry}>
            {retrying ? "Retrying..." : "Retry"}
          </DialogButton>
        </Focusable>
      </div>
    );
  }

  return (
    <div className="epic-card">
      <Identity initial="?" title="Not signed in" subtitle="Epic Games account" />
      <div className="epic-dim">
        Sign in on the Epic Games Store inside Steam and your games show up here.
      </div>
      <Focusable className="epic-actions" flow-children="horizontal">
        <DialogButton className="epic-grow" onClick={() => open(SIGN_IN_URL)}>
          Sign in to Epic Games
        </DialogButton>
      </Focusable>
    </div>
  );
}

function LibraryCard({
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
  const sync = useSyncExternalStore(steamLibrary.subscribe, steamLibrary.getSyncState);
  // A clean up only disables the buttons; its progress is in the Maintenance card.
  const syncing = sync.active && sync.operation === "sync";

  const total = games?.length ?? 0;
  const installed = games?.filter((game) => game.installed).length ?? 0;
  const busy = loading || sync.active;

  let subtitle: string;
  if (games === undefined) subtitle = "Reading your library...";
  else if (total === 0) subtitle = "No games yet";
  else subtitle = `${plural(total, "game")} · ${installed} installed · ${describeAge(refreshedAt)}`;

  let primary: string;
  if (syncing) primary = "Syncing...";
  else if (synced === 0) primary = "Add to Steam";
  else if (synced < total) primary = `Add ${total - synced} more`;
  else primary = "Sync now";

  const shown = error
    ? { text: error, error: true }
    : (message ?? (sync.active || !sync.lastResult ? undefined : describeResult(sync.lastResult)));

  const onSync = () => {
    if (!games) return;
    setMessage(undefined);
    // The service owns progress and result so they survive the dialog closing.
    void steamLibrary.sync(games);
  };

  return (
    <div className="epic-card">
      <Identity initial={name.charAt(0).toUpperCase() || "E"} title={name} subtitle={subtitle} />
      {syncing ? (
        <Meter
          label={sync.total ? "Adding to Steam" : "Checking your Steam library..."}
          done={sync.done}
          total={sync.total}
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
      <Focusable className="epic-actions" flow-children="horizontal">
        <DialogButton className="epic-grow" disabled={busy || total === 0} onClick={onSync}>
          {primary}
        </DialogButton>
        <DialogButton className="epic-fixed" disabled={busy} onClick={refresh}>
          {loading ? "Checking..." : "Refresh"}
        </DialogButton>
      </Focusable>
    </div>
  );
}

export function PluginPanel() {
  const status = useSyncExternalStore(account.subscribe, account.get);
  const name = status?.authenticated ? (status.account ?? "Epic Games") : undefined;
  // Keyed by the account, so switching accounts reloads the library.
  const view = useLibrary(name);
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const games = name !== undefined ? view.games : undefined;
  const ready = games !== undefined && view.synced > 0;

  return (
    <div className="epic-panel">
      <style>{PANEL_CSS}</style>
      {name !== undefined ? (
        <LibraryCard name={name} view={view} message={message} setMessage={setMessage} />
      ) : (
        <AccountCard status={status} />
      )}
      {ready && <Options games={games} setMessage={setMessage} />}
      <Maintenance games={games} canRedownload={ready} />
    </div>
  );
}

export function UnsupportedPanel() {
  return (
    <div className="epic-panel">
      <style>{PANEL_CSS}</style>
      <div className="epic-card">
        <Identity initial="!" title="Windows only" subtitle="Epic Games" />
        <div className="epic-dim">
          Epic Games doesn't support this platform yet, so your library was left as it was.
        </div>
      </div>
    </div>
  );
}
