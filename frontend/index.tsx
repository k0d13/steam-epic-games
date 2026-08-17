import { definePlugin, IconsModule } from "@steambrew/client";
import { Logger } from "steambrew-utils/logger";
import { AuthPanel } from "./components/auth-panel";

export const logger = new Logger("Steam Epic Games");

// IconsModule is typed as `any` and its contents vary between Steam builds, so
// fall back rather than letting a missing icon take the whole plugin down.
const PluginIcon = IconsModule?.Download ?? IconsModule?.Settings ?? (() => null);

export default definePlugin(async () => {
  logger.info("Plugin loaded");

  // Millennium renders this as the plugin's own panel, which is where setup
  // lives. It's reachable whether or not anything has been signed in yet -
  // unlike the app properties dialog, which needs a game to open first.
  return {
    title: "Epic Games",
    icon: <PluginIcon />,
    content: <AuthPanel />,
  };
});
