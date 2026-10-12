import { Millennium } from "@steambrew/client";
import { asArray, createCall } from "./call";
import { logger } from "./logger";

const call = createCall((name, payload) => Millennium.callServerMethod(name, { payload }), 120_000);

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
  /** What Epic is shipping now. Different from `version` is what an update is. */
  latestVersion?: string;
  needsUpdate: boolean;
  /** Directory Epic expects the game in, which is what legendary names it. */
  folderName?: string;
  artPortrait?: string;
  artHero?: string;
  /** Unix seconds Epic granted the account the game, its purchase date. */
  purchasedAt?: number;
}

/** How much room a game takes, in bytes. */
export interface GameSize {
  /** On disk once installed - what Steam labels "Space Required". */
  disk: number;
  /** Actually transferred, which is smaller: Epic ships its content compressed. */
  download: number;
}

/** One Epic achievement, unlocked or not. */
export interface Achievement {
  /** Epic's internal name, unique within the game. */
  id: string;
  name: string;
  description: string;
  unlocked: boolean;
  /** 0 to 1. Only the handful of achievements Epic tracks progress for move. */
  progress: number;
  /** Unix seconds, absent while locked. */
  unlockedAt?: number;
  icon?: string;
  /** Percent of players holding it. */
  rarity?: number;
  /** Undiscovered, so Steam draws it blurred. */
  hidden: boolean;
}

/** Every achievement one game has, with the account's progress folded in. */
export interface GameAchievements {
  total: number;
  unlocked: number;
  /** Unix seconds of the read from Epic, which is what makes this stale. */
  fetchedAt: number;
  achievements: Achievement[];
}

/** What Steam needs to create a shortcut that launches a game through legendary. */
interface LaunchCommand {
  exe: string;
  arguments: string;
  startDir: string;
}

/** How far along a running install is. Absent until legendary's first progress line. */
interface JobProgress {
  percent: number;
  downloaded: number;
  total: number;
  /** "00:10:00", straight from legendary. */
  eta?: string;
  elapsed?: string;
  /** MiB/s, raw off the wire. */
  speed?: number;
}

/** One detached legendary install, update or uninstall. */
export interface Job {
  appName: string;
  /** `update` is an install of the changed chunks only, and downloads like one. */
  kind: "install" | "update" | "uninstall";
  /**
   * `queued` is a job with no process behind it yet: legendary runs one at a
   * time, so the rest wait their turn. `paused` is a killed runner - legendary
   * has no pause, so resuming re-runs install.
   */
  state: "queued" | "running" | "paused" | "done" | "failed";
  /** When the job was asked for, which is also its place in the queue. */
  startedAt: number;
  /** When its runner was launched, absent while it is still queued. */
  spawnedAt?: number;
  exitCode?: number;
  progress?: JobProgress;
  error?: string;
}

interface LibraryResult {
  ok: boolean;
  error?: string;
  games: EpicGame[];
  /** Unix seconds of the last read from Epic, 0 if there has never been one. */
  refreshedAt: number;
}

interface RawLibrary {
  ok: boolean;
  error?: string;
  games?: EpicGame[];
  refreshedAt?: number;
}

/** One game's achievement counts, without the achievements themselves. */
export interface AchievementSummary {
  appName: string;
  total: number;
  unlocked: number;
  fetchedAt: number;
}

type RawAchievement = Omit<Achievement, "unlockedAt"> & { unlockedAt?: string };
type RawAchievements = Omit<GameAchievements, "achievements"> & {
  achievements?: RawAchievement[];
};

/**
 * Epic times its unlocks as "2026-06-12 21:21:24.391000+00:00", which is ISO
 * 8601 with a space where the T belongs - so Date can't read it as it stands,
 * and Steam wants Unix seconds anyway.
 */
function toAchievement(raw: RawAchievement): Achievement {
  const parsed = raw.unlockedAt ? Date.parse(raw.unlockedAt.replace(" ", "T")) : Number.NaN;

  return {
    ...raw,
    unlockedAt: Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000),
  };
}

function toLibrary(raw: RawLibrary): LibraryResult {
  return { ...raw, games: asArray(raw.games), refreshedAt: raw.refreshedAt ?? 0 };
}

class RPC {
  /**
   * Cached in the backend, because answering costs a subprocess launch; pass
   * `refresh` after anything that could have changed the answer.
   */
  async GetStatus(refresh = false) {
    return call<EpicStatus>("RPC.GetStatus", { refresh });
  }

  /**
   * Finish signing in, with the `authorizationCode` from Epic's redirect page.
   * The browser half happens in the panel - this is only the exchange.
   */
  async SignIn(code: string) {
    return call<{ ok: boolean; error?: string; status?: EpicStatus }>("RPC.SignIn", { code });
  }

  async SignOut() {
    return call<{ ok: boolean; error?: string; status?: EpicStatus }>("RPC.SignOut");
  }

  /**
   * Answered from the backend's cache unless `refresh` is set; `force` also
   * bypasses legendary's catalog cache, which is what picks up a newly bought
   * game.
   */
  async GetLibrary(refresh = false, force = false): Promise<LibraryResult> {
    return toLibrary(await call<RawLibrary>("RPC.GetLibrary", { refresh, force }));
  }

  /**
   * Re-read only what's installed on disk. No round trip to Epic, so it costs a
   * fraction of a full `GetLibrary(true)`: this is the refresh for after an
   * install or an uninstall, where the catalog can't have changed.
   */
  async GetInstalled(): Promise<LibraryResult> {
    return toLibrary(await call<RawLibrary>("RPC.GetLibrary", { installed: true }));
  }

  async GetLaunchCommand(appName: string): Promise<LaunchCommand | undefined> {
    const raw = await call<{ ok: boolean } & LaunchCommand>("RPC.GetLaunchCommand", {
      app_name: appName,
    });
    return raw.ok ? raw : undefined;
  }

  /**
   * Slow the first time it's asked for a given game - it fetches that game's
   * manifest from Epic - and cached in the backend from then on.
   */
  async GetGameSize(appName: string, refresh = false): Promise<GameSize | undefined> {
    const raw = await call<{ ok: boolean; error?: string } & GameSize>("RPC.GetGameSize", {
      app_name: appName,
      refresh,
    });

    if (!raw.ok) {
      logger.debug("Could not size the game", { appName, error: raw.error });
      return undefined;
    }

    return raw;
  }

  /**
   * Every achievement a game has, with what the account has unlocked. Costs a
   * round trip to Epic the first time it's asked for a given game; `refresh`
   * re-reads one that has gone stale because the game has been played since.
   */
  async GetAchievements(appName: string, refresh = false): Promise<GameAchievements | undefined> {
    const raw = await call<{ ok: boolean; error?: string } & RawAchievements>(
      "RPC.GetAchievements",
      { app_name: appName, refresh },
    );

    if (!raw.ok) {
      logger.debug("Could not read achievements", { appName, error: raw.error });
      return undefined;
    }

    return { ...raw, achievements: asArray(raw.achievements).map(toAchievement) };
  }

  /**
   * The achievement counts we already have cached, for every game at once.
   * Never asks Epic, so it's cheap enough to call at startup - which is what
   * the library home's completion sort needs, since it asks about every game.
   */
  async GetCachedAchievements(): Promise<Map<string, AchievementSummary>> {
    const raw = await call<{
      ok: boolean;
      error?: string;
      games?: AchievementSummary[];
    }>("RPC.GetCachedAchievements");

    if (!raw.ok) logger.debug("Could not read the cached achievements", { error: raw.error });

    return new Map(asArray(raw.games).map((summary) => [summary.appName, summary] as const));
  }

  /**
   * Returns as soon as the job is spawned - watch it with `GetJobs`. `basePath`
   * is the parent directory, `gameFolder` the directory name inside it,
   * matching legendary's own split.
   */
  async StartInstall(appName: string, basePath?: string, gameFolder?: string) {
    return this.startJob("RPC.StartInstall", {
      app_name: appName,
      base_path: basePath,
      game_folder: gameFolder,
    });
  }

  /** Update an installed game. Fails on the backend if it isn't installed. */
  async StartUpdate(appName: string) {
    return this.startJob("RPC.StartUpdate", { app_name: appName });
  }

  async StartUninstall(appName: string) {
    return this.startJob("RPC.StartUninstall", { app_name: appName });
  }

  private async startJob(
    route: `RPC.${string}`,
    payload: { app_name: string; base_path?: string; game_folder?: string },
  ) {
    const raw = await call<{ ok: boolean; job?: Job; error?: string }>(route, payload);

    if (!raw.ok || !raw.job) {
      logger.warn(`${route.slice(4)} failed`, { appName: payload.app_name, error: raw.error });
      return undefined;
    }

    return raw.job;
  }

  /** Every install and uninstall the backend knows about. Cheap enough to poll. */
  async GetJobs(): Promise<Job[]> {
    const raw = await call<{ ok: boolean; jobs?: Job[] }>("RPC.GetJobs");
    return asArray(raw.jobs);
  }

  async PauseJob(appName: string) {
    return (await call<{ ok: boolean }>("RPC.PauseJob", { app_name: appName })).ok;
  }

  async CancelJob(appName: string) {
    return (await call<{ ok: boolean }>("RPC.CancelJob", { app_name: appName })).ok;
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
