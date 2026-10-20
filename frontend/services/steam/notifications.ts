import { toaster } from "millennium";

// Download Complete goes to Steam's notification store the way the client's own
// does, so it gets its toast, tray entry and settings

// EClientUINotificationType's DownloadCompleted
const DOWNLOAD_COMPLETED = 1;

// Clear of the client's ids, which count up from 1, and its tests', from 10000
let nextId = 0x7f000000;

// A protobuf varint field
function field(number: number, value: number) {
  const bytes = [number << 3];
  let rest = value >>> 0;
  for (; rest > 0x7f; rest >>>= 7) bytes.push((rest & 0x7f) | 0x80);
  bytes.push(rest);
  return bytes;
}

export function notify(type: "download-completed", appId: number): void;
export function notify(title: string & {}, body: string, onClick?: () => void): void;
export function notify(
  typeOrTitle: "download-completed" | (string & {}),
  detail: number | string,
  onClick?: () => void,
) {
  if (typeof detail === "number") {
    // CClientNotificationDownloadCompleted: appid = 1, no dlc_appid, no remote client
    const message = new Uint8Array(field(1, detail));
    window.NotificationStore?.OnNotification(nextId++, DOWNLOAD_COMPLETED, message);
    return;
  }

  toaster.toast({ title: typeOrTitle, body: detail, onClick, playSound: false, duration: 5000 });
}
