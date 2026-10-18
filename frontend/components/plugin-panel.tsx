import { ConfirmModal, DialogButton, Focusable, showModal, Toggle } from "millennium";
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { open, SIGN_IN_URL } from "../patches/store-menu";
import * as artwork from "../services/artwork";
import { COLLECTION_NAME } from "../services/collection";
import * as hidden from "../services/hidden";
import { mainPopup } from "../services/popups";
import * as shortcuts from "../services/shortcuts";
import * as steamLibrary from "../services/steam-library";
import * as account from "../state/account";
import * as preferences from "../state/preferences";
import { plural } from "./format";
import { PANEL_CSS } from "./panel-styles";
import { type LibraryView, useLibrary } from "./use-library";

// One status card, then the options once there's something for them to act on,
// then maintenance, which works signed out so it can always undo the plugin.
// Every operation reports on the card's one meter, so nothing shifts as it runs.

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
function describeResult(result: shortcuts.SyncResult) {
  if (result.error) return `Sync stopped partway: ${result.error}`;

  const parts = [
    result.added && `${result.added} added`,
    result.removed && `${result.removed} removed`,
    result.failed && `${result.failed} couldn't be added`,
  ].filter(Boolean);

  return parts.length > 0 ? `Last sync: ${parts.join(", ")}.` : undefined;
}

/** A transient line under the meter, an error or not. */
interface Message {
  text: string;
  error?: boolean;
}

function Meter({ label, value, progress }: { label: ReactNode; value: string; progress: number }) {
  return (
    <div>
      <div className="epic-meter-label">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="epic-meter">
        <div
          className="epic-meter-fill"
          style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
        />
      </div>
    </div>
  );
}

function Identity({
  initial,
  title,
  subtitle,
}: {
  initial: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="epic-identity">
      <div className="epic-avatar">{initial}</div>
      <div className="epic-identity-text">
        <div className="epic-title">{title}</div>
        <div className="epic-dim">{subtitle}</div>
      </div>
    </div>
  );
}

function MessageLine({ message }: { message: Message | undefined }) {
  if (!message) return null;
  return <div className={message.error ? "epic-error" : "epic-dim"}>{message.text}</div>;
}

/** The card for every state but signed in: connecting, unavailable, signed out. */
function AccountCard({ status }: { status: EpicStatus | undefined }) {
  const [retrying, setRetrying] = useState(false);

  // Forcing a status re-runs the download, for a machine that was offline.
  const onRetry = async () => {
    setRetrying(true);
    try {
      await backend.GetStatus(true);
    } catch (reason: unknown) {
      console.warn("GetStatus failed", reason);
    }
    setRetrying(false);
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
          <DialogButton className="epic-grow" disabled={retrying} onClick={() => void onRetry()}>
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
  const sync = useSyncExternalStore(shortcuts.subscribeToSync, shortcuts.getSyncState);

  const total = games?.length ?? 0;
  const installed = games?.filter((game) => game.installed).length ?? 0;
  const busy = loading || sync.active;

  let subtitle: string;
  if (games === undefined) subtitle = "Reading your library...";
  else if (total === 0) subtitle = "No games yet";
  else subtitle = `${plural(total, "game")} · ${installed} installed · ${describeAge(refreshedAt)}`;

  // The meter shows a running sync, or else how much is in Steam. A clean up
  // reports in its own card, which is there signed out too.
  let meter: ReactNode = null;
  if (sync.active && sync.operation === "sync") {
    meter = (
      <Meter
        label={sync.total ? "Adding to Steam" : "Checking your Steam library..."}
        value={sync.total ? `${sync.done} / ${sync.total}` : ""}
        progress={sync.total ? sync.done / sync.total : 0}
      />
    );
  } else if (total > 0) {
    meter = (
      <Meter
        label={synced === 0 ? "Not in Steam yet" : "In your Steam library"}
        value={`${synced} / ${total}`}
        progress={synced / total}
      />
    );
  }

  const shown: Message | undefined = error
    ? { text: error, error: true }
    : (message ??
      (sync.lastResult && !sync.active
        ? (() => {
            const text = describeResult(sync.lastResult);
            return text ? { text, error: Boolean(sync.lastResult.error) } : undefined;
          })()
        : undefined));

  const onSync = () => {
    if (!games) return;
    setMessage(undefined);
    // The service owns progress and result so they survive the dialog closing.
    void steamLibrary.syncAll(games);
  };

  let primary: string;
  // A clean up only disables it; its progress is in the Maintenance card.
  if (sync.active && sync.operation === "sync") primary = "Syncing...";
  else if (synced === 0) primary = "Add to Steam";
  else if (synced < total) primary = `Add ${total - synced} more`;
  else primary = "Sync now";

  return (
    <div className="epic-card">
      <Identity initial={name.charAt(0).toUpperCase() || "E"} title={name} subtitle={subtitle} />
      {meter}
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

function OptionRow({
  title,
  detail,
  value,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  value: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className="epic-row">
      <div className="epic-row-text">
        <div>{title}</div>
        <div className="epic-dim">{detail}</div>
      </div>
      <div className="epic-row-control">
        <Toggle value={value} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

function Options({
  games,
  setMessage,
}: {
  games: EpicGame[];
  setMessage(message: Message | undefined): void;
}) {
  const prefs = useSyncExternalStore(preferences.subscribe, preferences.get);
  const sync = useSyncExternalStore(shortcuts.subscribeToSync, shortcuts.getSyncState);

  // Scans Steam's whole library, so only when the shortcuts can have changed.
  const duplicates = useMemo(
    () => (sync.active ? 0 : hidden.duplicateCount(games)),
    [games, sync.active],
  );

  return (
    <div>
      <div className="epic-heading">Options</div>
      <div className="epic-list">
        <OptionRow
          title="Add new games"
          detail="Keep Steam in step with Epic"
          value={prefs.autoSync}
          onChange={(value) => preferences.set("autoSync", value)}
        />
        <OptionRow
          title="Group in a collection"
          detail={`Named "${COLLECTION_NAME}"`}
          value={prefs.collection}
          disabled={sync.active}
          onChange={(value) =>
            void steamLibrary.setCollection(games, value).then((error) => {
              if (error) setMessage({ text: error, error: true });
            })
          }
        />
        <OptionRow
          title="Hide Steam duplicates"
          detail={
            duplicates === 0 ? "None right now" : `${plural(duplicates, "game")} owned on both`
          }
          value={prefs.hideDuplicates}
          disabled={sync.active}
          onChange={(value) => steamLibrary.setHideDuplicates(games, value)}
        />
      </div>
    </div>
  );
}

function Maintenance({
  games,
  canRedownload,
}: {
  games: EpicGame[] | undefined;
  canRedownload: boolean;
}) {
  const sync = useSyncExternalStore(shortcuts.subscribeToSync, shortcuts.getSyncState);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const cleaning = sync.active && sync.operation === "cleanUp";

  const onRedownload = () => {
    if (!games) return;
    artwork.forgetAll();
    setMessage(undefined);
    void steamLibrary.syncAll(games);
  };

  const onCleanUp = () =>
    showModal(
      <ConfirmModal
        strTitle="Remove Epic games from Steam?"
        strDescription={
          "Every Epic shortcut this plugin has added is removed, duplicates from " +
          "earlier installs included, with its artwork and the Epic Games collection. " +
          "Installed games and your Epic sign-in are kept, and Add to Steam brings it all back."
        }
        strOKButtonText="Remove"
        bDestructiveWarning
        onOK={() => {
          setMessage(undefined);
          void shortcuts.cleanUp().then((result) => {
            if (result.error)
              setMessage({ text: `Clean up stopped: ${result.error}`, error: true });
            else if (result.removed === 0) setMessage({ text: "There was nothing to remove." });
            else
              setMessage({
                text: `Removed ${plural(result.removed, "shortcut")}. Safe to uninstall now.`,
              });
          });
        }}
      />,
      // Explicit because showModal's default, findSP(), throws on this build.
      mainPopup()?.window,
    );

  return (
    <div>
      <div className="epic-heading">Maintenance</div>
      <div className="epic-card">
        {cleaning ? (
          <Meter
            label={sync.total ? "Removing from Steam" : "Finding shortcuts..."}
            value={sync.total ? `${sync.done} / ${sync.total}` : ""}
            progress={sync.total ? sync.done / sync.total : 0}
          />
        ) : (
          ((message && <MessageLine message={message} />) ?? (
            <div className="epic-dim">
              Clean up takes everything this plugin added out of Steam, duplicates included. Run it
              before uninstalling.
            </div>
          ))
        )}
        <Focusable className="epic-actions" flow-children="horizontal">
          {canRedownload && (
            <DialogButton className="epic-grow" disabled={sync.active} onClick={onRedownload}>
              Redownload art
            </DialogButton>
          )}
          <DialogButton className="epic-grow" disabled={sync.active} onClick={onCleanUp}>
            {cleaning ? "Removing..." : "Clean up"}
          </DialogButton>
        </Focusable>
      </div>
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
