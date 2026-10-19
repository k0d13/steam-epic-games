import { DialogButton } from "millennium";
import { useState } from "react";
import { open, SIGN_IN_URL } from "../../services/epic/store";
import { Actions, Busy, Card, Identity } from "../ui/primitives";

// Every state but signed in: connecting, unavailable, signed out
export function AccountCard({ status }: { status: EpicStatus | undefined }) {
  const [retrying, setRetrying] = useState(false);

  // Forcing a status re-runs the download, for a machine that was offline
  function retry() {
    setRetrying(true);
    backend
      .GetStatus(true)
      .catch((reason: unknown) => console.warn("GetStatus failed", reason))
      .finally(() => setRetrying(false));
  }

  if (!status) {
    return (
      <Card>
        <Identity initial="…" title="Connecting to Epic" subtitle="Starting legendary" />
      </Card>
    );
  }

  if (!status.available) {
    return (
      <Card>
        <Identity initial="!" title="Can't reach Epic" subtitle="legendary isn't running" />
        <div className="epic-error">
          {status.error ?? "legendary couldn't be downloaded or run."}
        </div>
        <Actions>
          <DialogButton className="epic-grow" disabled={retrying} onClick={retry}>
            {retrying ? <Busy>Retrying</Busy> : "Retry"}
          </DialogButton>
        </Actions>
      </Card>
    );
  }

  return (
    <Card>
      <Identity initial="?" title="Not signed in" subtitle="Epic Games account" />
      <div className="epic-dim">
        Sign in on the Epic Games Store inside Steam and your games show up here.
      </div>
      <Actions>
        <DialogButton className="epic-grow" onClick={() => open(SIGN_IN_URL)}>
          Sign in to Epic Games
        </DialogButton>
      </Actions>
    </Card>
  );
}
