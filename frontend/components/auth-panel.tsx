import { Button, Field, findClassModule, TextField } from "@steambrew/client";
import { useCallback, useEffect, useState } from "react";
import { logger } from "../index";
import rpc, { type EpicStatus } from "../rpc";

// `Button` is defined as `DialogButton.render({}).type`, which keeps only the
// bare <button> inside the wrapper - so none of the Steam classes DialogButton
// would have applied come along, and it renders unstyled. Hence buttonClassName
// below, pulled off the settings module so the buttons still look like Steam's.
const SettingsStyles = findClassModule((m) => m.SectionTopLine)!;

const buttonClassName = `${SettingsStyles.SettingsDialogButton} ${SettingsStyles.ShortcutChange} DialogButton`;

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

export function AuthPanel() {
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

  // The catch matters more than it looks. Without it a backend that throws -
  // or never answers - leaves `status` undefined forever, and the panel sits on
  // "Checking for legendary..." with nothing to say why. Failing visibly is the
  // difference between a bug someone can report and one that looks like a hang.
  useEffect(() => {
    let cancelled = false;
    rpc
      .GetStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch((reason: unknown) => {
        logger.info("GetStatus failed", reason);
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    setStatus(result.status);
    setBusy(false);
  }, [code]);

  const onSignOut = useCallback(async () => {
    setBusy(true);
    setError(undefined);

    const result = await rpc.SignOut();
    setStatus(result.status);
    setBusy(false);
  }, []);

  if (unreachable) {
    return (
      <Field
        label="Epic account"
        description="The plugin's backend didn't respond. Check the Millennium logs for details."
        bottomSeparator="none"
      />
    );
  }

  if (!status) return <Field description="Checking for legendary..." bottomSeparator="none" />;

  if (!status.available) {
    return (
      <Field
        label="Legendary is missing"
        description={status.error ?? "The bundled binary could not be found or run."}
        bottomSeparator="none"
      />
    );
  }

  if (status.authenticated) {
    return (
      <Field
        label="Epic account"
        description={`Signed in as ${status.account}`}
        bottomSeparator="none"
      >
        <Button className={buttonClassName} disabled={busy} onClick={onSignOut}>
          Sign out
        </Button>
      </Field>
    );
  }

  return (
    <>
      <Field
        label="Epic account"
        description="Not signed in. This opens Epic's login page in your browser."
        bottomSeparator={awaitingCode ? "standard" : "none"}
      >
        <Button className={buttonClassName} disabled={busy} onClick={onSignIn}>
          Sign in
        </Button>
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
          <Button
            className={buttonClassName}
            disabled={!code.trim() || busy}
            onClick={onSubmitCode}
          >
            {busy ? "Signing in..." : "Continue"}
          </Button>
        </Field>
      )}
    </>
  );
}
