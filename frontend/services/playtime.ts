import * as appIds from "../state/app-ids";

// Steam times a shortcut's last launch the same way it times a real game, so
// "has this been played since we last asked Epic?" is answerable without Epic -
// which is what keeps an achievement cache from going a stale window out of
// date after a session. Only launches through Steam count; a game started from
// the Epic launcher leaves this untouched, which is what the age check in
// state/achievements.ts is still there for.

/**
 * Unix seconds of the last time Steam launched a game, 0 if it never has. The
 * overview is Steam's and its fields are unversioned, so a build without this
 * one reads as "never played" rather than throwing on a render path.
 */
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

/**
 * Call back with the appid of every game Steam has just stopped running. The
 * registration isn't on every client build, so a missing one costs only the
 * refresh it would have triggered.
 */
export function onGameStopped(callback: (appId: number) => void): () => void {
  const sessions = (SteamClient as unknown as { GameSessions?: GameSessions }).GameSessions;
  if (typeof sessions?.RegisterForAppLifetimeNotifications !== "function") return () => {};

  const registration = sessions.RegisterForAppLifetimeNotifications((notification) => {
    if (!notification.bRunning) callback(notification.unAppID);
  });

  return () => registration.unregister();
}
