local fs = require("fs")
local json = require("json")
local log = require("core.log")
local utils = require("utils")

-- JSON caches on disk, where losing one only costs a refresh

local cache = {}

---Decode JSON, or nil for anything not shaped like a document, as a cjson error kills
---Millennium's whole Lua VM, pcall or not
---@param text string|nil
---@return any|nil
function cache.decode(text)
  local trimmed = utils.trim(text or "")
  local first, last = trimmed:sub(1, 1), trimmed:sub(-1)
  if (first == "{" and last == "}") or (first == "[" and last == "]") then
    -- Millennium's Linux decoder wraps integers at 32 bits, so a 2.5 GB size came back
    -- negative; ten digits and up are decoded as floats, exact below 2^53
    trimmed = trimmed:gsub("([:,%[]%s*)(%-?%d%d%d%d%d%d%d%d%d%d+)(%s*[,%]}])", "%1%2.0%3")
    return json.decode(trimmed)
  end
  return nil
end

---@param path string
---@param label string For the log line when the file is unreadable
---@return table|nil
function cache.read(path, label)
  if not fs.is_file(path) then
    return nil
  end

  local decoded = cache.decode(utils.read_file(path))
  if type(decoded) ~= "table" then
    log.warn("Unreadable " .. label .. " at " .. path)
    return nil
  end

  return decoded
end

---Through a temp file, so a crash mid-write can't leave a truncated document
---@param path string
---@param value table
---@param label string
---@return boolean written
function cache.write(path, value, label)
  fs.create_directories(fs.parent_path(path))

  local temp_path = path .. ".tmp"
  local ok, err = utils.write_file(temp_path, json.encode(value))
  if not ok then
    log.error("Could not write the " .. label .. " cache: " .. tostring(err))
    return false
  end

  -- rename won't overwrite on Windows, and a cache lost in between is just rebuilt
  if fs.is_file(path) then
    fs.remove(path)
  end
  if not fs.rename(temp_path, path) then
    log.error("Could not replace the " .. label .. " cache")
    return false
  end

  return true
end

---A table kept in a JSON file, read from disk on first use
---@param path string
---@param label string
function cache.open(path, label)
  local value
  local store = {}

  ---@return table
  function store.get()
    value = value or cache.read(path, label) or {}
    return value
  end

  function store.save()
    return cache.write(path, store.get(), label)
  end

  function store.clear()
    value = {}
    return store.save()
  end

  return store
end

return cache
