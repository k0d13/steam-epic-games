local millennium = require("millennium")
local utils = require("utils")

-- Where things live on disk, ours and legendary's.

local paths = {}

-- Millennium's data folder for the plugin. Not `utils.get_backend_path()`, which
-- comes back empty under `starlight watch`.
paths.DATA = millennium.steam_path() .. "/millennium/data/epic-games"

---An environment variable, or nil when it's unset or empty.
---@param name string
---@return string|nil
local function env(name)
  local value = utils.getenv(name)
  return value ~= "" and value or nil
end

---Where legendary keeps its config and caches.
---@return string
function paths.legendary_config()
  local override = env("LEGENDARY_CONFIG_PATH")
  if override then
    return override
  end

  local xdg = env("XDG_CONFIG_HOME")
  if xdg then
    return xdg .. "/legendary"
  end

  -- legendary expands `~` itself, which on Windows is the user profile.
  return (env("USERPROFILE") or env("HOME") or "") .. "/.config/legendary"
end

---The folder the Epic Games Launcher keeps one `.item` manifest per install in,
---on the system drive but not always C:.
---@return string
function paths.egl_manifests()
  return (env("PROGRAMDATA") or "C:/ProgramData") .. "/Epic/EpicGamesLauncher/Data/Manifests"
end

return paths
