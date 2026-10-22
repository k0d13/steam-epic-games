local cache = require("core.cache")
local fs = require("fs")
local legendary = require("epic.legendary")
local log = require("core.log")
local paths = require("core.paths")
local utils = require("utils")

-- Games installed by the Epic Games Launcher, brought into legendary so they show as
-- installed rather than offering a second download

local egl = {}

-- The manifests at the last sync, so a refresh with nothing new skips a legendary run
local synced

---Import what egl-sync can resolve, import-only so we never export into the launcher's
---library, and only where the launcher can be, as elsewhere legendary asks for its Wine
---prefix on stdin
function egl.sync()
  local path = paths.egl_manifests()
  if not path or not fs.is_directory(path) then
    return
  end

  local names = {}
  for _, entry in ipairs(fs.list(path) or {}) do
    if entry.is_file then
      table.insert(names, entry.name .. ":" .. (entry.size or 0))
    end
  end
  table.sort(names)
  local signature = table.concat(names, "\n")
  if signature == synced then
    return
  end

  local output, code = legendary.run({ "-y", "egl-sync", "--import-only", "--one-shot" })
  log.info("Epic Games Launcher sync: " .. utils.trim(output))
  if code == 0 then
    synced = signature
  end
end

---@return table<string, { title: string, install_path: string }> manifests by app name
local function get_manifests()
  local path = paths.egl_manifests()
  if not path or not fs.is_directory(path) then
    return {}
  end

  local manifests = {}
  for _, entry in ipairs(fs.list(path) or {}) do
    -- The folder also holds a Pending directory for in-progress installs
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

---egl-sync quietly skips manifests it can't resolve, so those go through legendary
---import instead, which is usually a no-op
---@param owned table[] Another account's games can't be imported
---@param installed table<string, table> legendary's installs by app name
---@return boolean imported Whether anything was, so the installs need re-reading
function egl.import_skipped(owned, installed)
  local manifests = get_manifests()
  local titles = {}

  for _, game in ipairs(owned) do
    local manifest = manifests[game.app_name]
    if manifest and not installed[game.app_name] then
      legendary.run({ "-y", "import", "--with-dlcs", game.app_name, manifest.install_path })
      table.insert(titles, manifest.title)
    end
  end

  if #titles > 0 then
    log.info("Imported launcher installs egl-sync skipped: " .. utils.join(titles, ", "))
  end
  return #titles > 0
end

return egl
