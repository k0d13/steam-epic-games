local fs = require("fs")
local json = require("json")
local logger = require("logger")
local utils = require("utils")

-- Small JSON documents kept under backend/data/cache. Every one of them is a
-- cache: losing one costs a refresh, so nothing here tries harder than that.

local cache = {}

---Decode a JSON file, or nil if it isn't there or can't be read.
---@param path string
---@param label string Used in the log line when the file is unreadable
---@return table|nil
function cache.read(path, label)
  if not fs.is_file(path) then
    return nil
  end

  local ok, decoded = pcall(json.decode, utils.read_file(path) or "")
  if not ok or type(decoded) ~= "table" then
    logger:warn("Cached " .. label .. " is unreadable, ignoring it")
    return nil
  end

  return decoded
end

---Write a JSON file through a temp file, so a crash mid-write can't leave a
---truncated document for the next boot to fail on.
---@param path string
---@param value table
---@param label string
---@return boolean written
function cache.write(path, value, label)
  fs.create_directories(fs.parent_path(path))

  local temp_path = path .. ".tmp"
  local ok, err = utils.write_file(temp_path, json.encode(value))
  if not ok then
    logger:error("Could not write the " .. label .. " cache: " .. tostring(err))
    return false
  end

  -- rename() won't replace an existing file on Windows. Losing the cache in the
  -- window between the two is survivable; the next refresh rebuilds it.
  if fs.is_file(path) then
    fs.remove(path)
  end
  if not fs.rename(temp_path, path) then
    logger:error("Could not replace the " .. label .. " cache")
    return false
  end

  return true
end

return cache
