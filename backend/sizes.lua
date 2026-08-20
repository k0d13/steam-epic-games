local disk = require("cache")
local legendary = require("legendary")
local logger = require("logger")
local utils = require("utils")

-- How much room a game needs before it's installed, for the "Space Required"
-- Steam shows beside the Install button. `legendary list` doesn't carry it and
-- `legendary info` costs a manifest fetch per title, so it's read one game at a
-- time and cached.

local sizes = {}

--- Keyed by app name, versioned by build id so a patched game is re-read.
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
  cache = disk.read(CACHE_PATH, "sizes") or {}
end

local function save()
  disk.write(CACHE_PATH, cache, "sizes")
end

---What one game needs on disk, from the cache if we've ever asked before.
---A miss blocks on `legendary info`, which fetches the manifest from Epic and
---takes several seconds - hence the frontend asking for it after the app page
---is already on screen.
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

  -- No manifest means legendary couldn't reach Epic, which is the offline
  -- answer rather than a failure worth showing.
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

---Forget one game's size, for after an install or update has changed the build
---it was measured against.
---@param app_name string
function sizes.forget(app_name)
  load()
  if cache[app_name] == nil then return end

  cache[app_name] = nil
  save()
end

return sizes
