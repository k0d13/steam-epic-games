import * as appIds from "../../state/app-ids";

// Steam's last-launch time says whether a game was played since we asked Epic;
// only Steam launches count, hence the age check in state/achievements
export function getLastPlayed(appName: string) {
  const appId = appIds.getAppId(appName);
  return (appId !== undefined && appStore.GetAppOverviewByAppID(appId)?.rt_last_time_played) || 0;
}

export function onGameStopped(callback: (appId: number) => void) {
  const registration = SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
    (notification) => {
      if (!notification.bRunning) callback(notification.unAppID);
    },
  );

  return () => registration.unregister();
}

// Unix seconds; a game already running when we loaded has no start, so isn't counted
export function onSessionEnded(
  callback: (appId: number, startedAt: number, endedAt: number) => void,
) {
  const startedAt = new Map<number, number>();

  const registration = SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
    (notification) => {
      const now = Math.floor(Date.now() / 1000);
      if (notification.bRunning) {
        startedAt.set(notification.unAppID, now);
        return;
      }

      const start = startedAt.get(notification.unAppID);
      startedAt.delete(notification.unAppID);
      if (start !== undefined) callback(notification.unAppID, start, now);
    },
  );

  return () => registration.unregister();
}
