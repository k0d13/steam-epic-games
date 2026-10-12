import * as appIds from "../state/app-ids";

// Steam's last-launch time says whether a game was played since we asked Epic.
// Only Steam launches count, hence the age check in state/achievements.ts.

/** Unix seconds of Steam's last launch, 0 if never or on a build without the field. */
export function getLastPlayed(appName: string): number {
  const appId = appIds.getAppId(appName);
  if (appId === undefined) return 0;

  if (typeof appStore?.GetAppOverviewByAppID !== "function") return 0;

  return appStore.GetAppOverviewByAppID(appId)?.rt_last_time_played ?? 0;
}

interface LifetimeNotification {
  unAppID: number;
  bRunning: boolean;
}

interface GameSessions {
  RegisterForAppLifetimeNotifications?(callback: (notification: LifetimeNotification) => void): {
    unregister(): void;
  };
}

/** Call back with each appid Steam stops running; a no-op on builds without the hook. */
export function onGameStopped(callback: (appId: number) => void): () => void {
  const sessions = (SteamClient as unknown as { GameSessions?: GameSessions }).GameSessions;
  if (typeof sessions?.RegisterForAppLifetimeNotifications !== "function") return () => {};

  const registration = sessions.RegisterForAppLifetimeNotifications((notification) => {
    if (!notification.bRunning) callback(notification.unAppID);
  });

  return () => registration.unregister();
}
