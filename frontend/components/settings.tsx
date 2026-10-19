import { ConfirmModal, DialogButton, Dropdown, Focusable, showModal, Toggle } from "millennium";
import { useEffect, useMemo, useState } from "react";
import * as artwork from "../services/artwork";
import { COLLECTION_NAME } from "../services/collection";
import * as hidden from "../services/hidden";
import { mainPopup } from "../services/popups";
import * as steamLibrary from "../services/steam-library";
import * as preferences from "../state/preferences";
import { useValue } from "../state/signal";
import { Busy, type Message, MessageLine, Meter, plural } from "./panel-ui";

// The panel's lower half: the options once there's something for them to act on,
// then maintenance, which works signed out so it can always undo the plugin.

function OptionRow(props: {
  title: string;
  detail: string;
  value: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className="epic-row">
      <div className="epic-row-text">
        <div>{props.title}</div>
        <div className="epic-dim">{props.detail}</div>
      </div>
      <div className="epic-row-control">
        <Toggle value={props.value} disabled={props.disabled} onChange={props.onChange} />
      </div>
    </div>
  );
}

/** The Proton every Epic game runs through, hidden where the backend has none to offer. */
function ProtonRow({ games }: { games: EpicGame[] }) {
  const [choice, setChoice] = useState<ProtonChoice | undefined>(undefined);

  useEffect(() => {
    void backend.GetProton().then(setChoice);
  }, []);

  if (!choice?.supported) return null;

  const options = [
    { data: "", label: "None" },
    ...choice.builds.map((build) => ({ data: build.path, label: build.name })),
  ];

  return (
    <div className="epic-row">
      <div className="epic-row-text">
        <div>Proton</div>
        <div className="epic-dim">
          {choice.builds.length === 0
            ? "Install Proton from Steam's library first"
            : "Each game gets its own prefix"}
        </div>
      </div>
      <div className="epic-row-control">
        <Dropdown
          rgOptions={options}
          selectedOption={choice.selected ?? ""}
          disabled={choice.builds.length === 0}
          onChange={(option) => {
            const path = option.data as string;
            setChoice({ ...choice, selected: path || null });
            void backend.SetProton(
              path,
              games.map((game) => game.app_name),
            );
          }}
        />
      </div>
    </div>
  );
}

export function Options({
  games,
  setMessage,
}: {
  games: EpicGame[];
  setMessage(message: Message | undefined): void;
}) {
  const prefs = useValue(preferences);
  const sync = useValue(steamLibrary.progress);

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
        <ProtonRow games={games} />
      </div>
    </div>
  );
}

function describeCleanUp(result: steamLibrary.CleanUpResult): Message {
  if (result.error) return { text: `Clean up stopped: ${result.error}`, error: true };
  if (result.removed === 0) return { text: "There was nothing to remove." };
  return { text: `Removed ${plural(result.removed, "shortcut")}. Safe to uninstall now.` };
}

export function Maintenance({
  games,
  canRedownload,
}: {
  games: EpicGame[] | undefined;
  canRedownload: boolean;
}) {
  const sync = useValue(steamLibrary.progress);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const cleaning = sync.active && sync.operation === "cleanUp";

  const onRedownload = () => {
    if (!games) return;
    artwork.forgetAll();
    setMessage(undefined);
    void steamLibrary.sync(games);
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
          void steamLibrary.cleanUp().then((result) => setMessage(describeCleanUp(result)));
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
            done={sync.done}
            total={sync.total}
          />
        ) : message ? (
          <MessageLine message={message} />
        ) : (
          <div className="epic-dim">
            Clean up takes everything this plugin added out of Steam, duplicates included. Run it
            before uninstalling.
          </div>
        )}
        <Focusable className="epic-actions" flow-children="horizontal">
          {canRedownload && (
            <DialogButton className="epic-grow" disabled={sync.active} onClick={onRedownload}>
              Redownload art
            </DialogButton>
          )}
          <DialogButton className="epic-grow" disabled={sync.active} onClick={onCleanUp}>
            {cleaning ? <Busy>Removing</Busy> : "Clean up"}
          </DialogButton>
        </Focusable>
      </div>
    </div>
  );
}
