import { useState } from "react";
import * as account from "../../state/account";
import { useValue } from "../../state/primitives";
import { type Message } from "../ui/primitives";
import { PANEL_CSS } from "../ui/styles";
import { AccountCard } from "./account-card";
import { LibraryCard } from "./library-card";
import { Maintenance } from "./maintenance";
import { Options } from "./options";
import { SupportCard } from "./support-card";
import { useLibrary } from "./use-library";

// One status card, then the options and maintenance; every operation reports on its
// card's one meter, so nothing shifts as it runs
export function PluginPanel() {
  const status = useValue(account);
  const name = status?.authenticated ? (status.account ?? "Epic Games") : undefined;
  // Keyed by the account, so switching accounts reloads the library
  const view = useLibrary(name);
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const games = name !== undefined ? view.games : undefined;
  const ready = games !== undefined && view.synced > 0;

  return (
    <div className="epic-panel">
      <style>{PANEL_CSS}</style>
      {name !== undefined ? (
        <LibraryCard name={name} view={view} message={message} setMessage={setMessage} />
      ) : (
        <AccountCard status={status} />
      )}
      {ready && <Options games={games} setMessage={setMessage} />}
      <Maintenance games={games} canRedownload={ready} />
      <SupportCard />
    </div>
  );
}
