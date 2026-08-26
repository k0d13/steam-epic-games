import { callable } from "@steambrew/webkit";
import { logger } from "./index";

/**
 * The store half's side of the backend, which is the client half's `rpc.ts`
 * with only the methods the store needs, and none of its imports: pulling in
 * the client one would drag `@steambrew/client` and the whole library state
 * into a bundle that runs in a web page with no Steam client around it.
 */

/** What a backend method answers while work too slow to hold the Lua state runs. */
interface Pending {
  pending: true;
  /** How long the backend wants before the next attempt, in milliseconds. */
  retryIn?: number;
}

const isPending = (value: unknown): value is Pending =>
  typeof value === "object" && value !== null && (value as Pending).pending === true;

/** Stop retrying eventually, so a backend stuck saying "pending" cannot hang a
 * caller for good. Shorter than the client half's, because nothing the store
 * asks for is worth holding a page open for two minutes. */
const RETRY_LIMIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Millennium hands the store a callable per method name, built once each. */
const callables = new Map<string, (args: { payload: string }) => Promise<string>>();

function endpoint(name: string) {
  let existing = callables.get(name);
  if (!existing) {
    existing = callable<[{ payload: string }], string>(name);
    callables.set(name, existing);
  }
  return existing;
}

// The backend speaks snake_case, because that's what legendary and Lua both
// use, so every answer is converted here once - same as the client half.
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

async function call<R>(route: `RPC.${string}`, payload: object = {}): Promise<R> {
  const name = route.slice(4);
  logger.debug(`-> ${name}`, payload);

  const body = JSON.stringify(payload);
  const deadline = Date.now() + RETRY_LIMIT_MS;

  for (;;) {
    const raw = await endpoint(name)({ payload: body });
    const parsed = camelize(JSON.parse(raw)) as R | Pending;

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
}

/** One game in the Epic library, cut down to what a store page can use. */
export interface EpicGame {
  /** Epic's internal id, and the stable key everything is stored under. */
  appName: string;
  title: string;
  installed: boolean;
}

export interface LibraryResult {
  ok: boolean;
  error?: string;
  games: EpicGame[];
}

interface RawLibrary {
  ok: boolean;
  error?: string;
  games?: EpicGame[];
}

/**
 * Lua has one table type, so an empty list arrives as `{}` - an object with no
 * `map` on it, and a TypeError on every fresh install.
 */
const asArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

export class RPC {
  /**
   * The Epic library, always from the backend's cache: this runs on every store
   * page, and reading Epic itself takes seconds. Whatever the client half last
   * cached is what the store sees.
   */
  async GetLibrary(): Promise<LibraryResult> {
    const raw = await call<RawLibrary>("RPC.GetLibrary");
    return { ...raw, games: asArray(raw.games) };
  }
}

export default new RPC();
