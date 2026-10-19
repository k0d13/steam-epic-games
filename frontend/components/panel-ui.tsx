import { Spinner } from "millennium";
import type { ReactNode } from "react";

// Steam's Field rows each draw as their own padded card, with toggles inset
// differently from buttons, which reads as ragged in a panel this narrow. So the
// panel lays itself out and keeps Steam's own buttons and toggles for the controls.
// Colours are Steam's own variables, so they follow its theme.

export const PANEL_CSS = `
.epic-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 16px;
  color: var(--gpSystemLighterGrey, #dcdedf);
  font-size: 13px;
  line-height: 1.4;
  /* Steam's light grey nudged toward its lighter one: on the cards' raised
     background the plain light grey falls just short of 4.5:1 at 12px. */
  --epic-dim: color-mix(
    in srgb,
    var(--gpSystemLightGrey, #8b929a) 75%,
    var(--gpSystemLighterGrey, #dcdedf)
  );
}

.epic-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.epic-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.epic-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--gpSystemDarkGrey, #3d4450);
  color: var(--gpColor-White, #fff);
  font-size: 17px;
  font-weight: 600;
}

.epic-identity-text {
  min-width: 0;
}

.epic-title {
  overflow: hidden;
  color: var(--gpColor-White, #fff);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.epic-dim {
  color: var(--epic-dim);
  font-size: 12px;
}

/* Steam exposes no red variable, so a fixed one, light enough for 4.5:1 on the cards. */
.epic-error {
  color: #ff7b72;
  font-size: 12px;
}

.epic-meter-label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--epic-dim);
  font-size: 12px;
}

.epic-meter-label strong {
  color: var(--gpSystemLighterGrey, #dcdedf);
  font-weight: 500;
}

.epic-meter {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
}

.epic-meter-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--gpColor-Blue, #1a9fff);
  transition: width 0.3s ease-out;
}

.epic-busy > svg {
  width: 1em;
  height: 1em;
  margin-right: 8px;
  vertical-align: -0.125em;
}

.epic-actions {
  display: flex;
  gap: 8px;
}

.epic-actions > .epic-grow {
  flex: 1;
  min-width: 0;
}

.epic-actions > .epic-fixed {
  flex: none;
  width: auto;
  min-width: 0;
  padding-left: 16px;
  padding-right: 16px;
}

/* Ko-fi's red, so the one button that isn't about the library reads as such.
   Darker than Ko-fi's own #ff5e5b, which only reaches 3:1 under white text. */
.epic-actions > .epic-kofi {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #d63c39;
  color: #fff;
}

.epic-actions > .epic-kofi:hover,
.epic-actions > .epic-kofi.gpfocus {
  background: #c2302d;
  color: #fff;
}

/* Replacing Steam's focus background leaves only a shade change, so add a ring. */
.epic-actions > .epic-kofi.gpfocus {
  outline: 2px solid var(--gpColor-White, #fff);
  outline-offset: 2px;
}

.epic-heading {
  margin: 0 2px 8px;
  color: var(--epic-dim);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.epic-list {
  overflow: hidden;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.epic-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 16px;
  box-sizing: border-box;
}

.epic-row + .epic-row {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.epic-row-text {
  flex: 1;
  min-width: 0;
}

.epic-row-control {
  flex: none;
}
`;

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A transient line under the meter, an error or not. */
export interface Message {
  text: string;
  error?: boolean;
}

/** `done` of `total`, or just the label while there's no total yet. */
export function Meter({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div>
      <div className="epic-meter-label">
        <span>{label}</span>
        <strong>{total ? `${done} / ${total}` : ""}</strong>
      </div>
      <div
        className="epic-meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total || undefined}
        aria-valuenow={total ? done : undefined}
      >
        <div
          className="epic-meter-fill"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}

/** Steam's spinner beside a button's label while it works, no taller than the text. */
export function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="epic-busy">
      <Spinner />
      {children}
    </span>
  );
}

export function Identity(props: { initial: string; title: string; subtitle: string }) {
  return (
    <div className="epic-identity">
      <div className="epic-avatar">{props.initial}</div>
      <div className="epic-identity-text">
        <div className="epic-title">{props.title}</div>
        <div className="epic-dim">{props.subtitle}</div>
      </div>
    </div>
  );
}

export function MessageLine({ message }: { message: Message | undefined }) {
  if (!message) return null;
  return <div className={message.error ? "epic-error" : "epic-dim"}>{message.text}</div>;
}
