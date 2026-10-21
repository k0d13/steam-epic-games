import { toaster } from "millennium";

// Download Complete and the cloud sync problems go to Steam's notification store the
// way the client's own do, so they get its toast, tray entry and settings

// EClientUINotificationType, by the name we take them by; each message is just an appid
const TYPES = {
  "download-completed": 1,
  "cloud-sync-failed": 15,
  "cloud-sync-conflict": 16,
} as const;

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

export function notify(type: keyof typeof TYPES, appId: number): void;
export function notify(title: string & {}, body: string, onClick?: () => void): void;
export function notify(
  typeOrTitle: keyof typeof TYPES | (string & {}),
  detail: number | string,
  onClick?: () => void,
) {
  if (typeof detail === "number") {
    // appid = 1 in all three, leaving out DownloadCompleted's dlc_appid and remote client
    const message = new Uint8Array(field(1, detail));
    const type = TYPES[typeOrTitle as keyof typeof TYPES];
    window.NotificationStore?.OnNotification(nextId++, type, message);
    return;
  }

  toaster.toast({ title: typeOrTitle, body: detail, onClick, playSound: false, duration: 5000 });
}
