--# selene: allow(unused_variable)
local cache = require("core.cache")
local egdata = require("epic.egdata")
local legendary = require("epic.legendary")
local log = require("core.log")
local paths = require("core.paths")

-- Steam's "Space Required" can't tell it's stale, so the frontend drops a size when a job touches
-- the game. egdata knows every build's size for one request; legendary's manifest is the fallback

---@class GameSize
---@field disk integer Bytes the installed game occupies
---@field download integer Bytes transferred, which is smaller as Epic ships compressed

local store = cache.open(paths.DATA .. "/cache/sizes.json", "sizes")

---The newest build of the game, preferring the live one legendary installs
---@param builds table[]
---@param app_name string
---@return table|nil
local function pick_build(builds, app_name)
  local best, best_live = nil, false
  for _, build in ipairs(builds) do
    if
      type(build) == "table"
      and build.appName == app_name
      and build.platform == "Windows"
      and type(build.installedSizeBytes) == "number"
    then
      local live = type(build.labelName) == "string" and build.labelName:find("^Live") ~= nil
      local seen = type(build.lastSeenAt) == "string" and build.lastSeenAt or ""
      if
        not best
        or (live and not best_live)
        or (live == best_live and seen > (best.lastSeenAt or ""))
      then
        best, best_live = build, live
      end
    end
  end
  return best
end

---@param app_name string
---@return GameSize|nil
local function from_egdata(app_name)
  local entry = legendary.catalog(app_name)
  local item_id = entry and entry.metadata.id
  if type(item_id) ~= "string" then
    return nil
  end

  local builds = egdata.builds(item_id)
  local build = builds and pick_build(builds, app_name)
  if not build then
    return nil
  end

  return {
    disk = build.installedSizeBytes,
    download = type(build.downloadSizeBytes) == "number" and build.downloadSizeBytes
      or build.installedSizeBytes,
  }
end

---@param app_name string
---@return GameSize|nil
local function from_legendary(app_name)
  local decoded, err = legendary.decode_json(legendary.run({ "info", app_name, "--json" }))
  -- No manifest means legendary could not reach Epic
  local manifest = type(decoded) == "table" and decoded.manifest or nil
  if type(manifest) ~= "table" or type(manifest.disk_size) ~= "number" then
    log.warn("Could not size " .. app_name .. ": " .. tostring(err))
    return nil
  end

  return {
    disk = manifest.disk_size,
    download = manifest.download_size or manifest.disk_size,
  }
end

---@ffi
---A miss costs a request to egdata, or a manifest fetch from Epic if it doesn't know the game
---@param app_name string
---@param refresh? boolean Re-read even if it's cached
---@return GameSize|nil
function GetGameSize(app_name, refresh)
  if not legendary.is_app_name(app_name) then
    return nil
  end

  local sizes = store.get()
  local cached = sizes[app_name]
  -- A negative size was wrapped by the Linux decoder before cache.decode fixed it
  if cached and cached.disk >= 0 and not refresh then
    return cached
  end

  local size = from_egdata(app_name) or from_legendary(app_name)
  if not size then
    return nil
  end

  sizes[app_name] = size
  store.save()

  log.info("Sized " .. app_name .. ": " .. size.disk .. " bytes on disk")
  return size
end
