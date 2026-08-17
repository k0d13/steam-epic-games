local fs = require("fs")
local json = require("json")
local legendary = require("legendary")
local logger = require("logger")
local utils = require("utils")

-- How much room a game needs before it's installed. Steam shows this next to
-- the Install button, and it's the one number `legendary list` doesn't carry -
-- only `legendary info` does, and that fetches the game's manifest from Epic,
-- so it costs a subprocess and a few seconds per title. Doing that for 200
-- games to fill in a field the user sees one game at a time is not worth it,
-- so this is asked for a game at a time and cached forever.

local sizes = {}

--- Keyed by app name. Versioned by build id so a game that has since been
--- patched is re-read rather than reporting last year's size.
local CACHE_PATH = utils.get_backend_path() .. "/data/sizes.json"

---@class GameSize
---@field disk integer Bytes the installed game occupies - what Steam calls "Space Required"
---@field download integer Bytes actually transferred, which is smaller: Epic ships compressed
---@field build_id string|nil The build this was measured against

---@type table<string, GameSize>
local cache = {}
local loaded = false

local function load()
  if loaded then return end
  loaded = true

  if not fs.is_file(CACHE_PATH) then return end

  local ok, decoded = pcall(json.decode, utils.read_file(CACHE_PATH) or "")
  if not ok or type(decoded) ~= "table" then
    logger:warn("Cached sizes are unreadable, ignoring them")
    return
  end

  cache = decoded
end

---Same temp-file dance as the library cache, for the same reason: a crash
---mid-write must not leave a truncated document for the next boot to choke on.
local function save()
  fs.create_directories(fs.parent_path(CACHE_PATH))

  local temp_path = CACHE_PATH .. ".tmp"
  local ok, err = utils.write_file(temp_path, json.encode(cache))
  if not ok then
    logger:error("Could not write the size cache: " .. tostring(err))
    return
  end

  if fs.is_file(CACHE_PATH) then fs.remove(CACHE_PATH) end
  if not fs.rename(temp_path, CACHE_PATH) then logger:error("Could not replace the size cache") end
end

---What one game needs on disk, from the cache if we've ever asked before.
---
---Blocks on `legendary info` on a miss, which goes out to Epic for the game's
---manifest - several seconds. That's why the frontend asks for this after the
---app page is already on screen rather than as part of loading the library.
---@param app_name string
---@param refresh boolean|nil Re-read even if it's cached
---@return GameSize|nil size
---@return string? error
function sizes.get(app_name, refresh)
  if type(app_name) ~= "string" or app_name == "" then return nil, "No app name provided" end

  load()
  if cache[app_name] and not refresh then return cache[app_name] end

  local output = legendary.run({ "info", app_name, "--json" })
  local decoded, err = legendary.decode_json(output)
  if type(decoded) ~= "table" then return nil, err or "legendary returned no info" end

  -- `manifest` is absent when legendary couldn't reach Epic, which is the
  -- normal offline answer rather than a broken install - so it's not an error
  -- worth surfacing, there's just nothing to show yet.
  local manifest = decoded.manifest
  if type(manifest) ~= "table" or type(manifest.disk_size) ~= "number" then
    return nil, "no manifest for " .. app_name
  end

  cache[app_name] = {
    disk = manifest.disk_size,
    download = manifest.download_size or manifest.disk_size,
    build_id = manifest.build_id,
  }
  save()

  logger:info("Sized " .. app_name .. ": " .. manifest.disk_size .. " bytes on disk")
  return cache[app_name]
end

---Forget one game's size, so the next ask re-reads it. For after an install or
---an update, when the build it was measured against is no longer the current one.
---@param app_name string
function sizes.forget(app_name)
  load()
  if cache[app_name] == nil then return end

  cache[app_name] = nil
  save()
end

return sizes
