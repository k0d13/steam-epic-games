import { DialogButton, Toggle } from "millennium";
import { useMemo } from "react";
import { COLLECTION_NAME } from "../../services/steam/collection";
import { duplicateCount } from "../../services/steam/hidden";
import { clearAll, loadAll } from "../../services/sync/caches";
import { setCollection, setHideDuplicates } from "../../services/sync/sync";
import * as preferences from "../../state/preferences";
import { useValue } from "../../state/primitives";
import { progress } from "../../state/sync-progress";
import { Busy, Card, type Message, Meter, plural, Row, Section } from "../ui/primitives";
import { ProtonRow } from "./proton-row";

// Shown once there's something for the options to act on
export function Options({
  games,
  setMessage,
}: {
  games: EpicGame[];
  setMessage(message: Message | undefined): void;
}) {
  const prefs = useValue(preferences);
  const { active, operation, done, total } = useValue(progress);
  const loading = active && operation === "load";

  // Scans Steam's whole library, so only when the shortcuts can have changed
  const duplicates = useMemo(() => (active ? 0 : duplicateCount(games)), [games, active]);

  function onCollection(value: boolean) {
    void setCollection(games, value).then((error) => {
      if (error) setMessage({ text: error, error: true });
    });
  }

  function onClear() {
    void clearAll().then((error) => {
      setMessage(
        error
          ? { text: `Couldn't clear the cache: ${error}`, error: true }
          : { text: "Cache cleared. Pages read everything again as they open." },
      );
    });
  }

  return (
    <Section heading="Options">
      <div className="epic-list">
        <Row title="Add new games" detail="Keep Steam in step with Epic">
          <Toggle value={prefs.autoSync} onChange={(value) => preferences.set("autoSync", value)} />
        </Row>
        <Row title="Group in a collection" detail={`Named "${COLLECTION_NAME}"`}>
          <Toggle value={prefs.collection} disabled={active} onChange={onCollection} />
        </Row>
        <Row
          title="Hide Steam duplicates"
          detail={
            duplicates === 0 ? "None right now" : `${plural(duplicates, "game")} owned on both`
          }
        >
          <Toggle
            value={prefs.hideDuplicates}
            disabled={active}
            onChange={(value) => setHideDuplicates(games, value)}
          />
        </Row>
        <Row
          title="Show game info"
          detail="Details, tags and genres from egdata; may clash with other plugins"
        >
          <Toggle value={prefs.gameInfo} onChange={(value) => preferences.set("gameInfo", value)} />
        </Row>
        <Row
          title="Load every game"
          detail={
            prefs.gameInfo
              ? "Read info and achievements now, so filters know all your games"
              : "Read achievements now; turn on game info to read that too"
          }
        >
          <DialogButton disabled={active} onClick={() => void loadAll(games)}>
            {loading ? <Busy>Loading</Busy> : "Load"}
          </DialogButton>
        </Row>
        <Row title="Clear cache" detail="Forget saved info, achievements and sizes">
          <DialogButton disabled={active} onClick={onClear}>
            Clear
          </DialogButton>
        </Row>
        <ProtonRow games={games} setMessage={setMessage} />
      </div>
      {loading && (
        <Card>
          <Meter label="Reading games" done={done} total={total} />
        </Card>
      )}
    </Section>
  );
}
