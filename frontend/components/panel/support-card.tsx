import { DialogButton } from "millennium";
import { Actions, Card } from "../ui/primitives";

const KOFI_URL = "https://ko-fi.com/X8X554X28";

// Last, so it never sits between someone and what they opened the panel for
export function SupportCard() {
  return (
    <Card>
      <div className="epic-dim">
        Made by one person in their spare time. If it saves you keeping a second launcher open, a
        coffee keeps it going.
      </div>
      <Actions>
        <DialogButton
          className="epic-grow epic-kofi"
          onClick={() => SteamClient.System.OpenInSystemBrowser(KOFI_URL)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 8h14v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" stroke="currentColor" strokeWidth="2" />
            <path
              d="M10 16.5s-3-1.8-3-3.8a1.6 1.6 0 0 1 3-.8 1.6 1.6 0 0 1 3 .8c0 2-3 3.8-3 3.8Z"
              fill="currentColor"
            />
          </svg>
          Support on Ko-fi
        </DialogButton>
      </Actions>
    </Card>
  );
}
