import { useCallback, useEffect, useState } from "react";
import { autoSync, syncedCount } from "../services/sync/sync";
import * as library from "../state/library";
import { useValue } from "../state/primitives";
import { progress } from "../state/sync-progress";

export interface LibraryView {
  // Undefined until the first read lands
  games: EpicGame[] | undefined;
  refreshedAt: number;
  loading: boolean;
  error: string | undefined;
  // Recounted whenever a sync or clean up ends
  synced: number;
  // Asks Epic again, picking up purchases legendary's catalog cache would miss
  refresh(): void;
}

// Reads the cache, then Epic if it was never fetched; `account` is undefined when
// nobody is signed in
export function useLibrary(account: string | undefined) {
  const [games, setGames] = useState<EpicGame[] | undefined>(undefined);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Subscribed only to re-render, so a sync that outlives the dialog still recounts
  useValue(progress);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(undefined);

    // Only the call is guarded, so UI errors aren't blamed on the backend
    let result: Library;
    try {
      // `force` too, as a refresh is for changes legendary's catalog cache would miss
      result = await library.load(refresh, refresh);
    } catch (reason: unknown) {
      console.warn("GetLibrary failed", reason);
      setError("The plugin's backend didn't respond.");
      setLoading(false);
      return undefined;
    }

    setError(result.error ?? undefined);
    setGames(result.games);
    setRefreshedAt(result.refreshed_at);
    setLoading(false);

    if (refresh) void autoSync(result);
    return result;
  }, []);

  // A refresh started elsewhere, like after a checkout, lands here too
  useEffect(() => {
    if (account === undefined) return;

    return library.subscribe(() => {
      const latest = library.getLatest();
      // A failed background read would empty the panel, and its own reads show errors
      if (!latest || latest.error) return;
      setGames(latest.games);
      setRefreshedAt(latest.refreshed_at);
    });
  }, [account]);

  useEffect(() => {
    if (account === undefined) return;

    // Nothing asks Epic on its own, so a first run fetches here
    void load(false).then((result) => {
      if (result && !result.error && result.refreshed_at === 0) void load(true);
    });
  }, [account, load]);

  const refresh = useCallback(() => void load(true), [load]);

  return { games, refreshedAt, loading, error, synced: games ? syncedCount(games) : 0, refresh };
}
