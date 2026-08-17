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
}

export default new RPC();
