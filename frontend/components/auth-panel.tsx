import { DialogButton, Field, TextField } from "@steambrew/client";
import { useCallback, useEffect, useState } from "react";
import { logger } from "../index";
import rpc, { type EpicStatus } from "../rpc";

/**
 * Open a URL outside Steam. Which of these exists varies by client build, and a
 * missing one off an optional chain fails silently - hence the logging.
 */
function openInBrowser(url: string) {
  // SteamClient.URL's interface is named `URL`, which TypeScript resolves to
  // the DOM's global instead - so this goes around the types.
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
 * Pull the authorization code out of whatever was pasted: Epic's page shows a
 * blob of JSON, and the bare code, the whole document and the redirect URL are
 * all reasonable things to copy off it.
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
  /** Called with every status this panel reads, so the library below can follow. */
  onStatus?: (status: EpicStatus) => void;
}

export function AuthPanel({ onStatus }: AuthPanelProps) {
  const [status, setStatus] = useState<EpicStatus | undefined>(undefined);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");

  // Separate from `status`: a backend that didn't answer is not a missing
  // binary, and saying so sends whoever debugs it to the wrong place.
  const [unreachable, setUnreachable] = useState(false);

  // Every path that learns a status goes through this, so nothing above
  // misses one.
  const applyStatus = useCallback(
    (next: EpicStatus | undefined) => {
      setStatus(next);
      if (next) onStatus?.(next);
    },
    [onStatus],
  );

  // Without the catch, a backend that throws leaves the panel on "Checking for
  // legendary..." forever with nothing to say why.
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

    // Single use, so clear it: pasting it again would only fail.
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
        {/* A refresh re-runs the download, for a machine that was offline when
            the plugin first asked. */}
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
        // childrenLayout="below" so the input gets the panel's full width;
        // inline, a paste this long runs off the edge.
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
