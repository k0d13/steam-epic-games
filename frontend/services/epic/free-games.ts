import * as preferences from "../../state/preferences";
import { createStore, poll } from "../../state/primitives";
import { notify } from "../steam/notifications";
import { EPIC_STORE, open } from "./store";

const FREE_GAMES_URL = `${EPIC_STORE}/free-games`;

// Epic swaps its free games every Thursday at 8:00 Pacific, so no request is needed to know when
const DROP_DAY = 4;
const DROP_HOUR = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Often enough to land close to the hour, and to catch up after the machine sleeps
const CHECK_MS = 60 * 1000;

const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

const store = createStore<number>("epic-games:free-games:v1");

// Pacific wall-clock time at `ms`, as if it were UTC
function pacificClock(ms: number) {
  const parts = Object.fromEntries(
    PACIFIC.formatToParts(ms).map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second);
}

// The latest Thursday 8:00 Pacific at or before `now`
function latestDrop(now: number) {
  const clock = new Date(pacificClock(now));
  const daysBack = (clock.getUTCDay() - DROP_DAY + 7) % 7;
  let drop = Date.UTC(
    clock.getUTCFullYear(),
    clock.getUTCMonth(),
    clock.getUTCDate() - daysBack,
    DROP_HOUR,
  );
  if (drop > clock.getTime()) drop -= WEEK_MS;

  // Back to a real instant; DST changes on a Sunday, so the offset at the drop is the one to use
  return drop - (pacificClock(drop) - drop);
}

function check() {
  const drop = latestDrop(Date.now());
  if (drop <= (store.get("notified") ?? 0)) return;

  // Marked even when off, so turning it on doesn't announce a week that's already out
  store.set("notified", drop);
  if (!preferences.get().freeGamesNotice) return;

  notify("New free games on Epic", "This week's free games are up on the Epic Games Store.", () =>
    open(FREE_GAMES_URL),
  );
}

// Announces the week's free games on the first start after Thursday's swap, or as it happens
export function watch() {
  return poll(check, CHECK_MS);
}
