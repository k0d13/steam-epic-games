import { DialogButton, Field, TextField } from "@steambrew/client";
import { useCallback, useEffect, useState } from "react";
import { logger } from "../index";
import rpc, { type EpicStatus } from "../rpc";

/**
 * Open a URL outside Steam.
 *
 * Tried in order because availability varies by client build: on this one
 * SteamClient.System.OpenInSystemBrowser doesn't exist, and calling a missing
 * method off an optional chain fails silently - the button simply does nothing,
 * with nothing logged to explain why. Hence also the logging.
 */
function openInBrowser(url: string) {
  // SteamClient.URL is declared with an interface literally named `URL`, which
  // TypeScript resolves to the DOM's global URL instead, hiding its real
  // members - so getting at ExecuteSteamURL means going around the types.
  const client = SteamClient as unknown as {
    URL?: { ExecuteSteamURL?(url: string): void };
    System?: { OpenInSystemBrowser?(url: string): void };
  };

  if (typeof client?.URL?.ExecuteSteamURL === "function") {
    logger.debug("Opening login page via SteamClient.URL.ExecuteSteamURL");
    client.URL.ExecuteSteamURL(`steam://openurl/${url}`);
    return true;
  }

  if (typeof client?.System?.OpenInSystemBrowser === "function") {
    logger.debug("Opening login page via SteamClient.System.OpenInSystemBrowser");
    client.System.OpenInSystemBrowser(url);
    return true;
  }

  logger.debug("Opening login page via window.open");
  return window.open(url, "_blank") !== null;
}

/**
 * Pull the authorization code out of whatever the user pasted.
 *
 * Epic's redirect page shows a blob of JSON, and which part of it someone copies
 * is anyone's guess - the bare code, the whole document, or the `redirectUrl`
 * inside it. All three are unambiguous, so accept all three rather than making
 * them trim it by hand.
 */
export function extractCode(pasted: string) {
  const trimmed = pasted.trim();

  return (
    trimmed.match(/"authorizationCode"\s*:\s*"([^"]+)"/)?.[1] ??
    trimmed.match(/[?&]code=([^&\s"]+)/)?.[1] ??
    trimmed
  );
}

export interface AuthPanelProps {
  /**
   * Called with every status this panel reads, so what's below it - the library,
   * which only means anything once there's an account - can follow along.
   */
  onStatus?: (status: EpicStatus) => void;
}

export function AuthPanel({ onStatus }: AuthPanelProps) {
  const [status, setStatus] = useState<EpicStatus | undefined>(undefined);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");

  // Kept apart from `status` rather than faked up as an unavailable one: a
  // backend that didn't answer is not the same thing as a missing binary, and
  // showing "Legendary is missing" for it sends anyone debugging this - me
  // included - looking in the wrong place entirely.
  const [unreachable, setUnreachable] = useState(false);

  // Every path that learns a status goes through this, so nothing above can be
  // told about a sign in and miss the sign out that follows it.
  const applyStatus = useCallback(
    (next: EpicStatus | undefined) => {
      setStatus(next);
      if (next) onStatus?.(next);
    },
    [onStatus],
  );

  // The catch matters more than it looks. Without it a backend that throws -
  // or never answers - leaves `status` undefined forever, and the panel sits on
  // "Checking for legendary..." with nothing to say why. Failing visibly is the
  // difference between a bug someone can report and one that looks like a hang.
  useEffect(() => {
    let cancelled = false;
    rpc
      .GetStatus()
      .then((result) => {
        if (!cancelled) applyStatus(result);
      })
      .catch((reason: unknown) => {
        logger.warn("GetStatus failed", reason);
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applyStatus]);

  const onRetry = useCallback(async () => {
    setBusy(true);
    try {
      applyStatus(await rpc.GetStatus(true));
    } catch (reason: unknown) {
      logger.warn("GetStatus failed", reason);
      setUnreachable(true);
    }
    setBusy(false);
  }, [applyStatus]);

  const onSignIn = useCallback(() => {
    const opened = openInBrowser(status?.loginUrl ?? "https://legendary.gl/epiclogin");
    setAwaitingCode(true);
    setError(opened ? undefined : "Couldn't open your browser. Use the address below instead.");
  }, [status?.loginUrl]);

  const onSubmitCode = useCallback(async () => {
    setBusy(true);
    setError(undefined);

    const result = await rpc.SignIn(extractCode(code));
    if (!result.ok) {
      setError(result.error ?? "Sign in failed");
      setBusy(false);
      return;
    }

    // The code is single use, so clear it - pasting it again would only fail.
    setCode("");
    setAwaitingCode(false);
    applyStatus(result.status);
    setBusy(false);
  }, [applyStatus, code]);

  const onSignOut = useCallback(async () => {
    setBusy(true);
    setError(undefined);

    const result = await rpc.SignOut();
    applyStatus(result.status);
    setBusy(false);
  }, [applyStatus]);

  if (unreachable) {
    return (
      <Field
        label="Epic account"
        description="The plugin's backend didn't respond. Check the Millennium logs for details."
        bottomSeparator="none"
      />
    );
  }

  if (!status) {
    return <Field description="Checking for legendary..." bottomSeparator="none" />;
  }

  if (!status.available) {
    return (
      <Field
        label="Legendary is missing"
        description={status.error ?? "Legendary could not be downloaded or run."}
        childrenContainerWidth="min"
        bottomSeparator="none"
      >
        {/* A refresh re-runs the download, since the usual reason to be here is
            a machine that was offline when the plugin first asked for it. */}
        <DialogButton disabled={busy} onClick={onRetry}>
          {busy ? "Downloading..." : "Retry"}
        </DialogButton>
      </Field>
    );
  }

  if (status.authenticated) {
    return (
      <Field
        label="Epic account"
        description={`Signed in as ${status.account}`}
        childrenContainerWidth="min"
        // The library rows render directly below, in the same section.
        bottomSeparator="standard"
      >
        <DialogButton disabled={busy} onClick={onSignOut}>
          Sign out
        </DialogButton>
      </Field>
    );
  }

  return (
    <>
      <Field
        label="Epic account"
        description="Not signed in. This opens Epic's login page in your browser."
        childrenContainerWidth="min"
        bottomSeparator={awaitingCode ? "standard" : "none"}
      >
        <DialogButton disabled={busy} onClick={onSignIn}>
          Sign in
        </DialogButton>
      </Field>

      {awaitingCode && (
        // childrenLayout="below" so the input gets the full width of the panel.
        // Inline, Steam squeezes it into the right-hand column and a paste this
        // long simply runs off the edge.
        <Field
          description={
            error ??
            "Epic will show you a page of text once you've signed in. Copy it - all " +
              "of it is fine - and paste it here."
          }
          childrenLayout="below"
          childrenContainerWidth="max"
          bottomSeparator="none"
        >
          <TextField
            value={code}
            focusOnMount
            // @ts-expect-error - placeholder is a valid input prop but isn't typed
            placeholder='{"authorizationCode": "..."}'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
          />
          <DialogButton disabled={!code.trim() || busy} onClick={onSubmitCode}>
            {busy ? "Signing in..." : "Continue"}
          </DialogButton>
        </Field>
      )}
    </>
  );
}
