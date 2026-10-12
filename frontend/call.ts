import { logger } from "./logger";

// How both bundles talk to the backend. They reach the same Lua methods by
// different means - Millennium's client API, a webkit `callable` - so each
// passes its own `send`, and nothing else here may import from either half.

/**
 * What a backend method answers instead of a result when the work it needs is
 * too slow to hold the Lua state for. RPC handlers run on Millennium's main
 * thread and cannot yield, so the only way not to block every other call is to
 * start the work, say so, and be asked again - which `call` does, invisibly to
 * everything above it.
 */
interface Pending {
  pending: true;
  /** How long the backend wants before the next attempt, in milliseconds. */
  retryIn?: number;
}

const isPending = (value: unknown): value is Pending =>
  typeof value === "object" && value !== null && (value as Pending).pending === true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The backend speaks snake_case, because that's what legendary and Lua both
// use. Converting every answer here once keeps the rest of the frontend in
// normal TS casing without a hand-written mapping per document - which was
// where a renamed backend field used to turn silently into `undefined`.
//
// Only answers are converted. Payloads still go out spelled the way the Lua
// side reads them.

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key.replace(/_(.)/g, (_, character: string) => character.toUpperCase())] =
      camelize(nested);
  }

  return result;
}

/**
 * `retryLimitMs` stops the retries eventually, so a backend stuck saying
 * "pending" cannot hang a caller for good.
 */
export function createCall(
  send: (name: string, payload: string) => Promise<string>,
  retryLimitMs: number,
) {
  return async <R>(route: `RPC.${string}`, payload: object = {}): Promise<R> => {
    const name = route.slice(4);
    logger.debug(`-> ${name}`, payload);

    const body = JSON.stringify(payload);
    const deadline = Date.now() + retryLimitMs;

    for (;;) {
      const parsed = camelize(JSON.parse(await send(name, body))) as R | Pending;

      if (!isPending(parsed)) {
        logger.debug(`<- ${name}`, parsed);
        return parsed;
      }

      if (Date.now() > deadline) {
        logger.warn(`${name} never stopped saying pending`);
        return parsed as R;
      }

      await sleep(parsed.retryIn ?? 250);
    }
  };
}

/**
 * Lua has one table type, so an empty list arrives as `{}` - an object with no
 * `map` on it, and a TypeError on every fresh install.
 */
export function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
