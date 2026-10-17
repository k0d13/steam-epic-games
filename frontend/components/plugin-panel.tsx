import { DialogButton, DialogControlsSection, Field } from "millennium";
import { useState, useSyncExternalStore } from "react";
import * as account from "../state/account";
import { LibraryPanel } from "./library-panel";

// Sign in and out happen on Epic's store in Steam's browser (see epic-session), so
// the panel only reports the account.
export function PluginPanel() {
  const status = useSyncExternalStore(account.subscribe, account.get);
  const [busy, setBusy] = useState(false);

  // Forcing a status re-runs the download, for a machine that was offline.
  const onRetry = async () => {
    setBusy(true);
    try {
      await backend.GetStatus(true);
    } catch (reason: unknown) {
      console.warn("GetStatus failed", reason);
    }
    setBusy(false);
  };

  let description: string;
  if (!status) description = "Checking for Legendary...";
  else if (!status.available)
    description = status.error ?? "Legendary could not be downloaded or run.";
  else if (status.authenticated) description = `Signed in as ${status.account}`;
  else
    description =
      "Not signed in. Open Store > Epic Games Store and sign in there, and this " +
      "picks up your account.";

  // One section: Steam drops the separator on a section's last field, so two
  // would leave the rows touching.
  return (
    <DialogControlsSection>
      <Field
        label="Epic account"
        description={description}
        childrenContainerWidth="min"
        bottomSeparator={status?.authenticated ? "standard" : "none"}
      >
        {status && !status.available && (
          <DialogButton disabled={busy} onClick={onRetry}>
            {busy ? "Downloading..." : "Retry"}
          </DialogButton>
        )}
      </Field>
      {status?.authenticated && <LibraryPanel />}
    </DialogControlsSection>
  );
}

export function UnsupportedPanel() {
  return (
    <DialogControlsSection>
      <Field
        label="Windows only"
        description="Epic Games doesn't support this platform yet, so it has left your library as it was."
        bottomSeparator="none"
      />
    </DialogControlsSection>
  );
}
