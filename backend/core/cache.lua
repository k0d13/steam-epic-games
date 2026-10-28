local fs = require("fs")
local json = require("json")
local log = require("core.log")
local paths = require("core.paths")
local utils = require("utils")

-- JSON caches on disk, where losing one only costs a refresh

local cache = {}

local function widen(number)
  if number:match("^%-?%d%d%d%d%d%d%d%d%d%d+$") then
    return number .. ".0"
  end
end

-- Counted back from the quote, as copying the string out to look copies every one
local function escaped(text, quote)
  local count = 0
  while text:byte(quote - count - 1) == 92 do
    count = count + 1
  end
  return count % 2 == 1
end

---Millennium's Linux decoder wraps integers at 32 bits, so a 2.5 GB size came back
---negative; ten digits and up are decoded as floats instead, exact below 2^53
---@param text string
local function widen_integers(text)
  local parts = {}
  local position = 1
  while true do
    local open = text:find('"', position, true)
    local outside = text:sub(position, (open or 0) - 1)
    table.insert(parts, (outside:gsub("%-?%d[%d%.eE%+%-]*", widen)))
    if not open then
      break
    end

    local close = text:find('"', open + 1, true)
    while close and escaped(text, close) do
      close = text:find('"', close + 1, true)
    end
    close = close or #text

    table.insert(parts, text:sub(open, close))
    position = close + 1
  end
  return table.concat(parts)
end

---Decode JSON, or nil for anything not shaped like a document, as a cjson error kills
---Millennium's whole Lua VM, pcall or not
---@param text string|nil
---@return any|nil
function cache.decode(text)
  if type(text) ~= "string" then
    return nil
  end

  -- Not trimmed, as that copies a document that can run to megabytes
  local first, last = text:match("^%s*([%[{])"), text:match("([%]}])%s*$")
  if first and last and (first == "{") == (last == "}") then
    return json.decode(paths.IS_WINDOWS and text or widen_integers(text))
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
