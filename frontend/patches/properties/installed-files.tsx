import { ButtonItem, DialogBody, findClassModule, findModuleExport } from "millennium";
import { type ReactNode, useSyncExternalStore } from "react";
import { badFiles, reacquiring } from "../../services/epic/verification";
import * as jobs from "../../state/jobs";
import * as library from "../../state/library";

// Installed Files, where Steam keeps Verify, and DLC are only a Steam game's pages.
// backend/patches.lua passes the Shortcut page and Steam's DLC page through
// `InstalledFilesPage`, which adds ours and the DLC page after it

interface Page {
  title: ReactNode;
  route: string;
  link: string;
  content: ReactNode;
}

// The page's CSS module, found by the classes only it has. Looked up as it's drawn until
// found, as it may not be registered when the plugin loads
let cached: Partial<Record<string, string>> | void;
function classes() {
  cached ??= findClassModule((found) => found.BrowseDiskRow && found.LocalFilesVerify);
  return cached ?? {};
}

// Steam's LocalizeString: the token, then the values for %1$s and so on
const localize = findModuleExport((value) =>
  /\.LocalizeString\([a-zA-Z_$][\w$]*\)/.test(String(value?.toString?.())),
) as ((token: string, ...values: unknown[]) => ReactNode) | undefined;

function text(token: string, fallback: string, ...values: unknown[]) {
  return localize?.(token, ...values) ?? fallback;
}

// What replaces the Verify row, as in Steam: progress while it works, then how it went
function status(job: Job, count: number | undefined) {
  const percent = Math.floor(job.progress?.percent ?? 0);

  if (job.kind === "verify") {
    if (job.state === "done") {
      const total = job.progress?.total ?? 0;
      return text(
        "#AppProperties_LocalFilesVerify_Complete",
        `All ${total} files successfully validated`,
        total,
      );
    }
    // Bad files are for a repair, which a new verify starts, so it's the button again
    if (job.state === "failed") {
      return badFiles(job) === undefined
        ? `Couldn't verify the files: ${job.error || "legendary stopped unexpectedly."}`
        : undefined;
    }
    return (
      <>
        {text("#AppProperties_LocalFilesVerify_VerifyingFiles", "Verifying integrity of files...")}{" "}
        {percent}%
      </>
    );
  }

  if (
    job.kind === "repair" &&
    count !== undefined &&
    job.state !== "done" &&
    job.state !== "failed"
  ) {
    return text(
      "#AppProperties_LocalFilesVerify_Failed",
      `${count} files failed to validate and will be reacquired.`,
      count,
    );
  }

  return undefined;
}

function InstalledFiles({ appId }: { appId: number }) {
  const game = library.getByAppId(appId);
  const job = useSyncExternalStore(jobs.subscribe, () => game && jobs.get(game.app_name));
  if (!game) return null;

  const shown = job && status(job, reacquiring(game.app_name));
  // Also while half done and paused
  const busy = jobs.isBusy(job) || job?.state === "paused";
  const styles = classes();

  return (
    <DialogBody>
      {shown ? (
        <div className={styles.LocalFilesVerify}>{shown}</div>
      ) : (
        <div className={[styles.SectionTopLine, styles.NoPadding].join(" ")}>
          <ButtonItem
            // Steam's classes on the row, which ButtonItem's typings don't list
            {...{ className: styles.SettingsDialogButton }}
            label={
              <div className={styles.TwoLineLabel}>
                {text(
                  "#AppProperties_LocalFilesVerifyLabel_game",
                  "Verify this game's files are installed correctly",
                )}
              </div>
            }
            bottomSeparator="standard"
            disabled={busy}
            onClick={() => void jobs.verify(game.app_name)}
          >
            {text("#AppProperties_LocalFilesVerify_game", "Verify integrity of game files")}
          </ButtonItem>
        </div>
      )}
    </DialogBody>
  );
}

export function InstalledFilesPage(appId: number, shortcut: Page, dlc: Page) {
  const game = library.getByAppId(appId);
  if (!game) return [shortcut];

  const pages = [shortcut];
  if (game.installed) {
    pages.push({
      title: text("#AppProperties_LocalFilesPage", "Installed Files"),
      route: "/app/:appid/properties/localfiles",
      link: `/app/${appId}/properties/localfiles`,
      content: <InstalledFiles appId={appId} />,
    });
  }
  if (game.dlcs.length > 0) pages.push(dlc);
  return pages;
}
