import { Focusable, Spinner } from "millennium";
import type { ReactNode } from "react";

export function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// A transient line under the meter, an error or not
export interface Message {
  text: string;
  error?: boolean;
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="epic-card">{children}</div>;
}

export function Actions({ children }: { children: ReactNode }) {
  return (
    <Focusable className="epic-actions" flow-children="grid">
      {children}
    </Focusable>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div>
      <div className="epic-heading">{heading}</div>
      {children}
    </div>
  );
}

export function Row({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="epic-row">
      <div className="epic-row-text">
        <div>{title}</div>
        <div className="epic-dim">{detail}</div>
      </div>
      <div className="epic-row-control">{children}</div>
    </div>
  );
}

// Just the label while there's no total yet
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

// Steam's spinner beside a button's label while it works, no taller than the text
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
