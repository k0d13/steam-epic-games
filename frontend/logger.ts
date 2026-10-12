// Its own module, with no imports, so the store bundle can log with the same
// badge without pulling in the client half.

const BADGE = "Steam Epic Games";
const BADGE_STYLE = "background: #2a2a2a; color: white; border-radius: 2px;";
function log(write: (...args: unknown[]) => void, ...args: unknown[]) {
  write(`%c ${BADGE} %c`, BADGE_STYLE, "background: transparent;", ...args);
}
export const logger = {
  debug: (...args: unknown[]) => log(console.debug, ...args),
  info: (...args: unknown[]) => log(console.info, ...args),
  warn: (...args: unknown[]) => log(console.warn, ...args),
  error: (...args: unknown[]) => log(console.error, ...args),
};
