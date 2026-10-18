import { toaster } from "millennium";

// Steam's own toasts, through Millennium. Its toaster patches a Steam internal
// that may move between builds, so a toast that can't be shown is only logged.

export function notify(title: string, body: string) {
  try {
    toaster.toast({ title, body, playSound: false, duration: 5000 });
  } catch (reason: unknown) {
    console.warn("Couldn't show a toast", { title, body, reason });
  }
}
