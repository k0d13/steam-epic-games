local cache = require("cache")
local fs = require("fs")
local logger = require("logger")
local utils = require("utils")

-- Games installed by the Epic Games Launcher are invisible to legendary until
-- registered with it, and `egl-sync` quietly skips any manifest it can't fully
-- resolve. Its manifests are plain JSON in a fixed place, so the leftovers are
-- read here and handed to `legendary import`, which refetches the manifest from
-- Epic when the local one is unusable.

local egl = {}

---@class EglManifest
---@field app_name string Epic's app id, the same key legendary uses
---@field title string
---@field install_path string

---Every game the Epic Games Launcher currently has installed.
---@return EglManifest[]
function egl.get_manifests()
  -- One .item file per installed game, on the system drive but not always C:.
  local program_data = utils.getenv("PROGRAMDATA")
  if not program_data or program_data == "" then
    program_data = "C:/ProgramData"
  end
  local path = program_data .. "/Epic/EpicGamesLauncher/Data/Manifests"

  if not fs.is_directory(path) then
    logger:info("No Epic Games Launcher manifests at " .. path)
    return {}
  end

  local manifests = {}
  for _, entry in ipairs(fs.list(path) or {}) do
    -- The folder also holds a `Pending` directory for in-progress installs.
    if entry.is_file and utils.endswith(entry.name:lower(), ".item") then
      local decoded = cache.read(entry.path, "Epic Games Launcher manifest") or {}

      if decoded.bIsIncompleteInstall == true then
        logger:info(
          "Skipping incomplete Epic Games Launcher install: " .. tostring(decoded.DisplayName)
        )
      elseif type(decoded.AppName) == "string" and type(decoded.InstallLocation) == "string" then
        table.insert(manifests, {
          app_name = decoded.AppName,
          title = decoded.DisplayName or decoded.AppName,
          install_path = decoded.InstallLocation,
        })
      end
    end
  end

  return manifests
end

return egl
