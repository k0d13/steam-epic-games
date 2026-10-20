import { ConfirmModal, DialogButton, showModal } from "millennium";
import { type ReactElement, useState } from "react";
import { forgetAll } from "../../services/steam/artwork";
import { mainPopup } from "../../services/steam/popups";
import { clearAll } from "../../services/sync/caches";
import { type CleanUpResult, cleanUp } from "../../services/sync/clean-up";
import { sync } from "../../services/sync/sync";
import { useValue } from "../../state/primitives";
import { progress } from "../../state/sync-progress";
import {
  Actions,
  Busy,
  Card,
  type Message,
  MessageLine,
  Meter,
  plural,
  Section,
} from "../ui/primitives";

function describeCleanUp(result: CleanUpResult) {
  if (result.error) return { text: `Clean up stopped: ${result.error}`, error: true };
  if (result.removed === 0) return { text: "There was nothing to remove." };
  return { text: `Removed ${plural(result.removed, "shortcut")}. Safe to uninstall now.` };
}

// Works signed out, so it can always undo the plugin
export function Maintenance({
  games,
  canRedownload,
}: {
  games: EpicGame[] | undefined;
  canRedownload: boolean;
}) {
  const state = useValue(progress);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const cleaning = state.active && state.operation === "cleanUp";

  function confirm(modal: ReactElement) {
    // Explicit because showModal's default, findSP(), throws on this build
    showModal(modal, mainPopup()?.window);
  }

  function confirmRedownload() {
    if (!games) return;
    confirm(
      <ConfirmModal
        strTitle="Redownload every game's art?"
        strDescription={
          `Fetches the cover, banner and icon of all ${plural(games.length, "game")} from ` +
          "Epic again, replacing what's there now, art you set yourself in Steam included. " +
          "This takes a while, but you can keep using Steam meanwhile."
        }
        strOKButtonText="Redownload"
        onOK={() => {
          forgetAll();
          setMessage(undefined);
          void sync(games);
        }}
      />,
    );
  }

  function confirmClearCache() {
    confirm(
      <ConfirmModal
        strTitle="Clear the cache?"
        strDescription={
          "Forgets the details, achievements and install sizes read so far. Each game reads " +
          "them again as it's opened, so until then the library's filters and collections " +
          "won't know about them."
        }
        strOKButtonText="Clear"
        onOK={() => {
          setMessage(undefined);
          void clearAll().then((error) =>
            setMessage(
              error
                ? { text: `Couldn't clear the cache: ${error}`, error: true }
                : { text: "Cache cleared. Each game reads its details again as it's opened." },
            ),
          );
        }}
      />,
    );
  }

  function confirmCleanUp() {
    confirm(
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
          void cleanUp().then((result) => setMessage(describeCleanUp(result)));
        }}
      />,
    );
  }

  return (
    <Section heading="Maintenance">
      <Card>
        {cleaning ? (
          <Meter
            label={state.total ? "Removing from Steam" : "Finding shortcuts…"}
            done={state.done}
            total={state.total}
          />
        ) : message ? (
          <MessageLine message={message} />
        ) : (
          <div className="epic-dim">
            Clear cache forgets the details, achievements and sizes read so far. Clean up takes
            everything this plugin added out of Steam, duplicates included; run it before
            uninstalling.
          </div>
        )}
        <Actions>
          {canRedownload && (
            <DialogButton disabled={state.active} onClick={confirmRedownload}>
              Redownload art
            </DialogButton>
          )}
          <DialogButton disabled={state.active} onClick={confirmClearCache}>
            Clear cache
          </DialogButton>
          {/* Last, and across the row beneath the harmless pair when there is one */}
          <DialogButton
            className={canRedownload ? "epic-wide" : undefined}
            disabled={state.active}
            onClick={confirmCleanUp}
          >
            {cleaning ? <Busy>Removing</Busy> : "Clean up"}
          </DialogButton>
        </Actions>
      </Card>
    </Section>
  );
}
