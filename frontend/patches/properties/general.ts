import { type AppDetails, callOriginal, replacePatch } from "millennium";
import { extraArguments } from "../../services/steam/shortcuts";
import * as library from "../../state/library";

// An Epic game's General page edits only what follows `launch "<app name>"` in the shortcut's
// options, which legendary passes to the game; Steam Cloud stays on, as Epic syncs any saves

// For library/app-details
export function applyGeneral(details: AppDetails) {
  details.strLaunchOptions = extraArguments(
    details.strShortcutLaunchOptions || details.strLaunchOptions || "",
  );
}

export function register() {
  const patches = [
    replacePatch(SteamClient.Apps, "SetAppLaunchOptions", ([appId, options]: [number, string]) => {
      const game = library.getByAppId(appId);
      if (!game) return callOriginal;

      void backend.GetLaunchCommand(game.app_name).then((launch) => {
        if (!launch) return;
        SteamClient.Apps.SetShortcutLaunchOptions(
          appId,
          options ? `${launch.arguments} ${options}` : launch.arguments,
        );
      });
      return undefined;
    }),

    replacePatch(SteamClient.Apps, "ToggleAppSteamCloudEnabled", ([appId]: [number]) =>
      library.getByAppId(appId) ? undefined : callOriginal,
    ),
  ];

  return () => patches.forEach((patch) => patch.unpatch());
}
