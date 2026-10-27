import { type AppDetails, callOriginal, replacePatch } from "millennium";
import { extraArguments } from "../../services/steam/shortcuts";
import * as library from "../../state/library";

// Steam's General page, which an Epic game has in place of Shortcut, edits the launch
// options the shortcut runs legendary with, so it shows and saves only what follows
// `launch "<app name>"`, which legendary passes on to the game. Epic syncs a game's saves
// whenever it has them, so its Steam Cloud toggle stays on

// For library/app-details
export function applyGeneral(details: AppDetails) {
  details.strLaunchOptions = extraArguments(
    details.strShortcutLaunchOptions || details.strLaunchOptions || "",
  );
}

export function register() {
  const launchOptions = replacePatch(
    SteamClient.Apps,
    "SetAppLaunchOptions",
    ([appId, options]: [number, string]) => {
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
    },
  );

  const cloudToggle = replacePatch(
    SteamClient.Apps,
    "ToggleAppSteamCloudEnabled",
    ([appId]: [number]) => (library.getByAppId(appId) ? undefined : callOriginal),
  );

  return () => {
    launchOptions.unpatch();
    cloudToggle.unpatch();
  };
}
