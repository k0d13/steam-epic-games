local cache = require("cache")
local fs = require("fs")
local log = require("log")
local paths = require("paths")

-- `egl-sync` quietly skips Epic Games Launcher manifests it can't resolve, so the
-- leftovers are read here and handed to `legendary import` instead.

local egl = {}

---@class EglManifest
---@field app_name string Epic's app id, the same key legendary uses
---@field title string
---@field install_path string

---Every game the Epic Games Launcher currently has installed.
---@return EglManifest[]
function egl.get_manifests()
  local path = paths.egl_manifests()

  if not fs.is_directory(path) then
    log.info("No Epic Games Launcher manifests at " .. path)
    return {}
  end

  local manifests = {}
  for _, entry in ipairs(fs.list(path) or {}) do
    -- The folder also holds a `Pending` directory for in-progress installs.
    if entry.is_file and fs.extension(entry.path):lower() == ".item" then
      local decoded = cache.read(entry.path, "Epic Games Launcher manifest") or {}

      if decoded.bIsIncompleteInstall == true then
        log.info(
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
