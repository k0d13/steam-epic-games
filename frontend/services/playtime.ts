import * as appIds from "../state/app-ids";

// Steam's last-launch time says whether a game was played since we asked Epic.
// Only Steam launches count, hence the age check in state/achievements.ts.

/** Unix seconds of Steam's last launch, 0 if never. */
export function getLastPlayed(appName: string): number {
  const appId = appIds.getAppId(appName);
  return (appId !== undefined && appStore.GetAppOverviewByAppID(appId)?.rt_last_time_played) || 0;
}

/** Call back with each appid Steam stops running. */
export function onGameStopped(callback: (appId: number) => void): () => void {
  const registration = SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
    (notification) => {
      if (!notification.bRunning) callback(notification.unAppID);
    },
  );

  return () => registration.unregister();
}
