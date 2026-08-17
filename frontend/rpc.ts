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

/** What Steam needs to create a shortcut that launches a game through legendary. */
export interface LaunchCommand {
  exe: string;
  arguments: string;
  startDir: string;
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
