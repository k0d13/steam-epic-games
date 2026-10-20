import { Toggle } from "millennium";
import { useMemo } from "react";
import { COLLECTION_NAME } from "../../services/steam/collection";
import { duplicateCount } from "../../services/steam/hidden";
import { setCollection, setHideDuplicates } from "../../services/sync/sync";
import * as preferences from "../../state/preferences";
import { useValue } from "../../state/primitives";
import { progress } from "../../state/sync-progress";
import { type Message, plural, Row, Section } from "../ui/primitives";
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
  const { active } = useValue(progress);

  // Scans Steam's whole library, so only when the shortcuts can have changed
  const duplicates = useMemo(() => (active ? 0 : duplicateCount(games)), [games, active]);

  function onCollection(value: boolean) {
    void setCollection(games, value).then((error) => {
      if (error) setMessage({ text: error, error: true });
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
        <Row title="Send play time to Epic" detail="So Epic counts time played from Steam">
          <Toggle
            value={prefs.reportPlaytime}
            onChange={(value) => preferences.set("reportPlaytime", value)}
          />
        </Row>
        <ProtonRow games={games} setMessage={setMessage} />
      </div>
    </Section>
  );
}
