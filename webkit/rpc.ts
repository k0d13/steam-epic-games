import { callable } from "@steambrew/webkit";
import { asArray, createCall } from "../frontend/call";

/**
 * The store half's side of the backend: only the method the store needs, and
 * nothing from the client half's `rpc.ts`, which would drag `@steambrew/client`
 * and the whole library state into a bundle that runs in a web page with no
 * Steam client around it.
 */

// A shorter retry limit than the client half's, because nothing the store asks
// for is worth holding a page open for two minutes.
const call = createCall(
  (name, payload) => callable<[{ payload: string }], string>(name)({ payload }),
  30_000,
);

/** One game in the Epic library, cut down to what a store page can use. */
export interface EpicGame {
  /** Epic's internal id, and the stable key everything is stored under. */
  appName: string;
  title: string;
  installed: boolean;
}

/**
 * The Epic library, always from the backend's cache: this runs on every store
 * page, and reading Epic itself takes seconds. Whatever the client half last
 * cached is what the store sees.
 */
export async function getLibrary() {
  const raw = await call<{ ok: boolean; error?: string; games?: EpicGame[] }>("RPC.GetLibrary");
  return { ...raw, games: asArray(raw.games) };
}
