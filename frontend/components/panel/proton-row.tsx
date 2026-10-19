import { Dropdown } from "millennium";
import { useEffect, useState } from "react";
import { type Message, Row } from "../ui/primitives";

// The Proton every Epic game runs through, hidden where the backend has none to offer
export function ProtonRow({
  games,
  setMessage,
}: {
  games: EpicGame[];
  setMessage(message: Message | undefined): void;
}) {
  const [choice, setChoice] = useState<ProtonChoice | undefined>(undefined);

  useEffect(() => {
    backend
      .GetProton()
      .then(setChoice)
      .catch((reason: unknown) => {
        console.warn("GetProton failed", reason);
        setMessage({ text: "Couldn't read the Proton builds.", error: true });
      });
  }, []);

  if (!choice?.supported) return null;

  const options = [
    { data: "", label: "None" },
    ...choice.builds.map((build) => ({ data: build.path, label: build.name })),
  ];

  function select(path: string) {
    if (!choice) return;
    const previous = choice;

    // Shown straight away, and put back if the backend didn't take it
    setChoice({ ...previous, selected: path || null });
    const failed = (reason?: unknown) => {
      if (reason) console.warn("SetProton failed", reason);
      setChoice(previous);
      setMessage({ text: "Couldn't change the Proton build.", error: true });
    };

    backend
      .SetProton(
        path,
        games.map((game) => game.app_name),
      )
      .then((ok) => {
        if (!ok) failed();
      })
      .catch(failed);
  }

  return (
    <Row
      title="Proton"
      detail={
        choice.builds.length === 0
          ? "Install Proton from Steam's library first"
          : "Each game gets its own prefix"
      }
    >
      <Dropdown
        rgOptions={options}
        selectedOption={choice.selected ?? ""}
        disabled={choice.builds.length === 0}
        onChange={(option) => select(option.data as string)}
      />
    </Row>
  );
}
