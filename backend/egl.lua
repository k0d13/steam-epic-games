local cache = require("cache")
local fs = require("fs")
local legendary = require("legendary")
local log = require("log")
local paths = require("paths")
local utils = require("utils")

-- Games installed by the Epic Games Launcher, brought into legendary so they show
-- as installed rather than offering a second download.

local egl = {}

---Import what `egl-sync` can resolve. `--import-only` so we never export into the
---launcher's library.
function egl.sync()
  local output = legendary.run({ "-y", "egl-sync", "--import-only", "--one-shot" })
  log.info("Epic Games Launcher sync: " .. utils.trim(output))
end

---Every install the launcher has a manifest for, as app_name -> install path.
---@return table<string, { title: string, install_path: string }>
local function get_manifests()
  local path = paths.egl_manifests()
  if not fs.is_directory(path) then
    return {}
  end

  local manifests = {}
  for _, entry in ipairs(fs.list(path) or {}) do
    -- The folder also holds a `Pending` directory for in-progress installs.
    if entry.is_file and fs.extension(entry.path):lower() == ".item" then
      local decoded = cache.read(entry.path, "Epic Games Launcher manifest") or {}

      if
        decoded.bIsIncompleteInstall ~= true
        and type(decoded.AppName) == "string"
        and type(decoded.InstallLocation) == "string"
      then
        manifests[decoded.AppName] = {
          title = decoded.DisplayName or decoded.AppName,
          install_path = decoded.InstallLocation,
        }
      end
    end
  end

  return manifests
end

---`egl-sync` quietly skips manifests it can't resolve, so hand those to `legendary
---import` instead. Usually a no-op.
---@param owned table[] Decoded `legendary list` output; another account's games can't be imported
---@param installed table<string, table> legendary's installs by app name
---@return boolean imported Whether anything was, so the installs need re-reading
function egl.import_skipped(owned, installed)
  local manifests = get_manifests()
  local titles = {}

  for _, game in ipairs(owned) do
    local manifest = manifests[game.app_name]
    if manifest and not installed[game.app_name] then
      -- `--skip-dlcs` avoids a prompt with no stdin to answer it; DLC follows the
      -- base game.
      legendary.run({ "-y", "import", "--skip-dlcs", game.app_name, manifest.install_path })
      table.insert(titles, manifest.title)
    end
  end

  if #titles > 0 then
    log.info("Imported launcher installs egl-sync skipped: " .. utils.join(titles, ", "))
  end
  return #titles > 0
end

return egl
