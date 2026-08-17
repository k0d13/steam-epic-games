import { Millennium } from "@steambrew/client";
import { logger } from "./index";

async function call<R>(route: `RPC.${string}`, payload: object = {}): Promise<R> {
  const name = route.slice(4);
  logger.debug(`-> ${name}`, payload);

  const raw = await Millennium.callServerMethod(name, { payload: JSON.stringify(payload) });
  const parsed = JSON.parse(raw) as R;

  logger.debug(`<- ${name}`, parsed);
  return parsed;
}

/** Whether legendary is usable, and whether an Epic account is signed in. */
export interface EpicStatus {
  available: boolean;
  authenticated: boolean;
  account?: string;
  loginUrl: string;
  error?: string;
}

/** One game the signed in Epic account owns, installed or not. */
export interface EpicGame {
  /** Epic's internal id, and the stable key everything here is stored under. */
  appName: string;
  title: string;
  installed: boolean;
  installPath?: string;
  installSize?: number;
  version?: string;
  needsUpdate: boolean;
  artPortrait?: string;
  artHero?: string;
}

/** How much room a game takes, in bytes. */
export interface GameSize {
  /** On disk once installed - what Steam labels "Space Required". */
  disk: number;
  /** Actually transferred, which is smaller: Epic ships its content compressed. */
  download: number;
}

/** What Steam needs to create a shortcut that launches a game through legendary. */
export interface LaunchCommand {
  exe: string;
  arguments: string;
  startDir: string;
}

/** How far along a running install is. Absent until legendary's first progress line. */
export interface JobProgress {
  percent: number;
  downloaded: number;
  total: number;
  /** "00:10:00", straight from legendary. */
  eta?: string;
  elapsed?: string;
  /** MiB/s, raw off the wire. */
  speed?: number;
  updatedAt: number;
}

/** One detached legendary install or uninstall. */
export interface Job {
  appName: string;
  kind: "install" | "uninstall";
  /** `paused` is a killed runner - legendary has no pause, so resuming re-runs install. */
  state: "running" | "paused" | "done" | "failed";
  startedAt: number;
  exitCode?: number;
  progress?: JobProgress;
  error?: string;
}

// The backend speaks snake_case because that's what legendary and Lua both use.
// Converting once here keeps the rest of the frontend in normal TS casing.

interface RawStatus {
  available: boolean;
  authenticated: boolean;
  account?: string;
  login_url: string;
  error?: string;
}

function toStatus(raw: RawStatus): EpicStatus {
  return {
    available: raw.available,
    authenticated: raw.authenticated,
    account: raw.account,
    loginUrl: raw.login_url,
    error: raw.error,
  };
}

interface RawAuthResult {
  ok: boolean;
  error?: string;
  status?: RawStatus;
}

function toAuthResult(raw: RawAuthResult) {
  return {
    ok: raw.ok,
    error: raw.error,
    status: raw.status ? toStatus(raw.status) : undefined,
  };
}

interface RawGame {
  app_name: string;
  title: string;
  installed: boolean;
  install_path?: string;
  install_size?: number;
  version?: string;
  needs_update: boolean;
  art_portrait?: string;
  art_hero?: string;
}

function toGame(raw: RawGame): EpicGame {
  return {
    appName: raw.app_name,
    title: raw.title,
    installed: raw.installed,
    installPath: raw.install_path,
    installSize: raw.install_size,
    version: raw.version,
    needsUpdate: raw.needs_update,
    artPortrait: raw.art_portrait,
    artHero: raw.art_hero,
  };
}

interface RawLibrary {
  ok: boolean;
  error?: string;
  games?: RawGame[];
  refreshed_at?: number;
}

export interface LibraryResult {
  ok: boolean;
  error?: string;
  games: EpicGame[];
  /** Unix seconds of the last read from Epic, 0 if there has never been one. */
  refreshedAt: number;
}

interface RawJob {
  app_name: string;
  kind: "install" | "uninstall";
  state: "running" | "paused" | "done" | "failed";
  started_at: number;
  exit_code?: number;
  error?: string;
  progress?: {
    percent: number;
    downloaded: number;
    total: number;
    eta?: string;
    elapsed?: string;
    speed?: number;
    updated_at: number;
  };
}

function toJob(raw: RawJob): Job {
  return {
    appName: raw.app_name,
    kind: raw.kind,
    state: raw.state,
    startedAt: raw.started_at,
    exitCode: raw.exit_code,
    error: raw.error,
    progress: raw.progress && {
      percent: raw.progress.percent,
      downloaded: raw.progress.downloaded,
      total: raw.progress.total,
      eta: raw.progress.eta,
      elapsed: raw.progress.elapsed,
      speed: raw.progress.speed,
      updatedAt: raw.progress.updated_at,
    },
  };
}

export class RPC {
  /**
   * Is legendary usable, and is an Epic account signed in? Cached in the backend
   * because answering costs a subprocess launch; pass `refresh` after anything
   * that could have changed the answer.
   */
  async GetStatus(refresh = false) {
    return toStatus(await call<RawStatus>("RPC.GetStatus", { refresh }));
  }

  /**
   * Finish signing in, with the `authorizationCode` from Epic's redirect page.
   * The browser half happens in the panel - this is only the exchange.
   */
  async SignIn(code: string) {
    return toAuthResult(await call<RawAuthResult>("RPC.SignIn", { code }));
  }

  async SignOut() {
    return toAuthResult(await call<RawAuthResult>("RPC.SignOut"));
  }

  /**
   * Everything the account owns, merged with what's installed on disk. Answered
   * from the backend's cache unless `refresh` is set; `force` also bypasses
   * legendary's catalog cache, which is what picks up a newly bought game.
   */
  async GetLibrary(refresh = false, force = false): Promise<LibraryResult> {
    const raw = await call<RawLibrary>("RPC.GetLibrary", { refresh, force });

    // Lua has one table type, so an empty library arrives as `{}` - an object
    // with no `map` on it, and a TypeError on every fresh install.
    const games = Array.isArray(raw.games) ? raw.games : [];

    return {
      ok: raw.ok,
      error: raw.error,
      games: games.map(toGame),
      refreshedAt: raw.refreshed_at ?? 0,
    };
  }

  /**
   * Re-read only what's installed on disk. No round trip to Epic, so it costs a
   * fraction of a full `GetLibrary(true)` - this is the refresh for after an
   * install or an uninstall, where the catalog can't have changed.
   */
  async GetInstalled(): Promise<LibraryResult> {
    const raw = await call<RawLibrary>("RPC.GetLibrary", { installed: true });

    // Lua has one table type, so an empty library arrives as `{}` - an object
    // with no `map` on it, and a TypeError on every fresh install.
    const games = Array.isArray(raw.games) ? raw.games : [];

    return {
      ok: raw.ok,
      error: raw.error,
      games: games.map(toGame),
      refreshedAt: raw.refreshed_at ?? 0,
    };
  }

  /** What a shortcut for this game should run. */
  async GetLaunchCommand(appName: string): Promise<LaunchCommand | undefined> {
    const raw = await call<{ ok: boolean; exe?: string; arguments?: string; start_dir?: string }>(
      "RPC.GetLaunchCommand",
      { app_name: appName },
    );

    if (!raw.ok || !raw.exe) return undefined;
    return { exe: raw.exe, arguments: raw.arguments ?? "", startDir: raw.start_dir ?? "" };
  }

  /**
   * How much room one game needs on disk. Slow the first time it's asked for a
   * given game - it fetches that game's manifest from Epic - and cached in the
   * backend from then on.
   */
  async GetGameSize(appName: string, refresh = false): Promise<GameSize | undefined> {
    const raw = await call<{ ok: boolean; disk?: number; download?: number; error?: string }>(
      "RPC.GetGameSize",
      { app_name: appName, refresh },
    );

    if (!raw.ok || raw.disk === undefined) {
      logger.debug("Could not size the game", { appName, error: raw.error });
      return undefined;
    }

    return { disk: raw.disk, download: raw.download ?? raw.disk };
  }

  /**
   * Start installing, updating or resuming a game. Returns as soon as the job
   * is spawned - watch it with `GetJobs`. `basePath` is the parent directory,
   * `gameFolder` the directory name inside it, matching legendary's own split.
   */
  async StartInstall(appName: string, basePath?: string, gameFolder?: string) {
    const raw = await call<{ ok: boolean; job?: RawJob; error?: string }>("RPC.StartInstall", {
      app_name: appName,
      base_path: basePath,
      game_folder: gameFolder,
    });

    if (!raw.ok || !raw.job) {
      logger.info("Could not start the install", { appName, error: raw.error });
      return undefined;
    }

    return toJob(raw.job);
  }

  /** Remove a game from disk, leaving its Steam shortcut in place. */
  async StartUninstall(appName: string) {
    const raw = await call<{ ok: boolean; job?: RawJob; error?: string }>("RPC.StartUninstall", {
      app_name: appName,
    });

    if (!raw.ok || !raw.job) {
      logger.info("Could not start the uninstall", { appName, error: raw.error });
      return undefined;
    }

    return toJob(raw.job);
  }

  /** Every install and uninstall the backend knows about. Cheap enough to poll. */
  async GetJobs(): Promise<Job[]> {
    const raw = await call<{ ok: boolean; jobs?: RawJob[] }>("RPC.GetJobs");

    // Lua has one table type, so no jobs at all arrives as `{}`, not `[]`.
    return Array.isArray(raw.jobs) ? raw.jobs.map(toJob) : [];
  }

  /** Stop an install, keeping the partial download. `StartInstall` resumes it. */
  async PauseJob(appName: string) {
    const raw = await call<{ ok: boolean }>("RPC.PauseJob", { app_name: appName });
    return raw.ok;
  }

  /** Stop a job and forget it. Whatever is on disk stays there. */
  async CancelJob(appName: string) {
    const raw = await call<{ ok: boolean }>("RPC.CancelJob", { app_name: appName });
    return raw.ok;
  }

  /**
   * Rename the icon Steam just wrote into the name it reads icons back from,
   * and return where that ended up. See services/icons.ts.
   */
  async PlaceIcon(appId: number, accountId?: number) {
    const raw = await call<{ ok: boolean; path?: string; error?: string }>("RPC.PlaceIcon", {
      app_id: appId,
      account_id: accountId,
    });

    if (!raw.ok) {
      logger.debug("Could not place the icon", { appId, error: raw.error });
      return undefined;
    }

    return raw.path;
  }
}

export default new RPC();
