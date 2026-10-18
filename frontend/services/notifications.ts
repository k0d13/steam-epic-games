import { toaster } from "millennium";

// One way to raise a notification, whatever draws it. Kinds Steam has a type for
// go to its notification store the way the client's own do, so they get its toast,
// tray entry and settings; anything else is a plain title and body through
// Millennium's toaster.

/** EClientUINotificationType, for the kinds Steam draws. */
const DOWNLOAD_COMPLETED = 1;

/** Clear of the client's ids, which count up from 1, and its tests', from 10000. */
let nextId = 0x7f000000;

/** A protobuf varint. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

/** A protobuf varint field. */
const field = (number: number, value: number) => [number << 3, ...varint(value)];

function steam(type: number, message: number[]) {
  const store = globalThis.NotificationStore;
  if (!store) {
    console.warn("Steam's notification store wasn't found", { type });
    return;
  }
  store.OnNotification(nextId++, type, new Uint8Array(message));
}

function message(title: string, body: string) {
  try {
    toaster.toast({ title, body, playSound: false, duration: 5000 });
  } catch (reason: unknown) {
    console.warn("Couldn't show a toast", { title, body, reason });
  }
}

/** Steam's Download Complete for an app, as it raises for its own downloads. */
export function notify(type: "downloadCompleted", appId: number): void;
/** A plain title and body. */
export function notify(type: "message", title: string, body: string): void;
export function notify(type: "downloadCompleted" | "message", ...args: unknown[]) {
  switch (type) {
    // CClientNotificationDownloadCompleted: appid = 1; no dlc_appid, no remote client.
    case "downloadCompleted":
      steam(DOWNLOAD_COMPLETED, field(1, args[0] as number));
      return;
    case "message":
      message(args[0] as string, args[1] as string);
      return;
  }
}
