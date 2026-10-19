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
