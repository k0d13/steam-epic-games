// Steam's Field rows each draw as their own padded card, with toggles inset
// differently from buttons, which reads as ragged in a panel this narrow. So the
// panel lays itself out and keeps Steam's own buttons and toggles for the controls.
// Colours are Steam's: its body text, its dim text and the blue its toggles use.

export const PANEL_CSS = `
.epic-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 16px;
  color: #dcdedf;
  font-size: 13px;
  line-height: 1.4;
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
  background: #3d4450;
  color: #fff;
  font-size: 17px;
  font-weight: 600;
}

.epic-identity-text {
  min-width: 0;
}

.epic-title {
  overflow: hidden;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.epic-dim {
  color: #8b929a;
  font-size: 12px;
}

.epic-error {
  color: #ff7b72;
  font-size: 12px;
}

.epic-meter-label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: #8b929a;
  font-size: 12px;
}

.epic-meter-label strong {
  color: #dcdedf;
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
  background: #1a9fff;
  transition: width 0.3s ease-out;
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

.epic-heading {
  margin: 0 2px 8px;
  color: #8b929a;
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
      <div className="epic-meter">
        <div
          className="epic-meter-fill"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </div>
    </div>
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
