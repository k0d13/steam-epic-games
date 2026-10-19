--# selene: allow(unused_variable)
local cache = require("core.cache")
local legendary = require("epic.legendary")
local log = require("core.log")
local paths = require("core.paths")

-- Steam's "Space Required", one manifest fetch per game and cached with no way to tell
-- it's stale, so the frontend drops a game's size when a job touches it

---@class GameSize
---@field disk integer Bytes the installed game occupies
---@field download integer Bytes transferred, which is smaller as Epic ships compressed

local store = cache.open(paths.DATA .. "/cache/sizes.json", "sizes")

---@ffi
---A miss costs a manifest fetch from Epic
---@param app_name string
---@param refresh? boolean Re-read even if it's cached
---@return GameSize|nil
function GetGameSize(app_name, refresh)
  local sizes = store.get()
  local cached = sizes[app_name]
  -- A negative size was wrapped by the Linux decoder before cache.decode fixed it
  if cached and cached.disk >= 0 and not refresh then
    return cached
  end

  local decoded, err = legendary.decode_json(legendary.run({ "info", app_name, "--json" }))
  -- No manifest means legendary could not reach Epic
  local manifest = type(decoded) == "table" and decoded.manifest or nil
  if type(manifest) ~= "table" or type(manifest.disk_size) ~= "number" then
    log.warn("Could not size " .. app_name .. ": " .. tostring(err))
    return nil
  end

  sizes[app_name] = {
    disk = manifest.disk_size,
    download = manifest.download_size or manifest.disk_size,
  }
  store.save()

  log.info("Sized " .. app_name .. ": " .. manifest.disk_size .. " bytes on disk")
  return sizes[app_name]
end
