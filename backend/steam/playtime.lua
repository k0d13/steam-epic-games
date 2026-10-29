--# selene: allow(unused_variable)
local cache = require("core.cache")
local datetime = require("datetime")
local epic = require("epic.playtime")
local log = require("core.log")
local paths = require("core.paths")
local utils = require("utils")

-- A new shortcut starts Steam's play time at zero, so we keep a record by app name, outside the
-- cache folder as it can't be rebuilt, and show the larger of it and Epic's

---@class Playtime
---@field app_name string
---@field seconds integer
---@field last_played integer|nil Unix seconds, only known for sessions we saw end

local record = cache.open(paths.DATA .. "/playtime.json", "play time")
local epic_store = cache.open(paths.DATA .. "/cache/playtime.json", "Epic play time")

local MAX_PENDING = 100

-- Epic tells sessions apart by machine, and this stands in for the launcher's id
local function machine_id()
  local data = record.get()
  if type(data.machine_id) ~= "string" then
    utils.random_seed(datetime.now())
    local digits = {}
    for index = 1, 32 do
      digits[index] = string.format("%x", utils.random_int(0, 15))
    end
    data.machine_id = table.concat(digits)
    record.save()
  end
  return data.machine_id
end

---Sends what earlier reports couldn't, keeping whatever still fails
local function flush()
  local data = record.get()
  if type(data.pending) ~= "table" or #data.pending == 0 then
    return
  end

  local id = machine_id()
  local kept = {}
  for _, entry in ipairs(data.pending) do
    -- One failure means Epic or the session is down, so the rest wait for next time
    if #kept > 0 or not epic.report(id, entry.app_name, entry.started_at, entry.ended_at) then
      table.insert(kept, entry)
    end
  end

  data.pending = kept
  record.save()
end

local function refresh_totals()
  local totals = epic.totals()
  if totals then
    epic_store.get().totals = totals
    epic_store.save()
  end
end

---@param app_name string
---@return Playtime
local function combined(app_name)
  local ours = (record.get().games or {})[app_name] or {}
  local theirs = epic_store.get().totals or {}
  return {
    app_name = app_name,
    seconds = math.max(ours.seconds or 0, theirs[app_name] or 0),
    last_played = ours.last_played,
  }
end

---@ffi
---Every game's play time; a refresh asks Epic, otherwise its last answer is used
---@param refresh? boolean Also sends sessions earlier reports couldn't
---@return Playtime[]
function GetPlaytime(refresh)
  if refresh then
    flush()
    refresh_totals()
  end

  local names = {}
  for app_name in pairs(record.get().games or {}) do
    names[app_name] = true
  end
  for app_name in pairs(epic_store.get().totals or {}) do
    names[app_name] = true
  end

  local result = {}
  for app_name in pairs(names) do
    table.insert(result, combined(app_name))
  end
  return result
end

---@ffi
---Adds a session Steam saw end to our record, and to Epic's
---@param app_name string
---@param started_at integer Unix seconds
---@param ended_at integer Unix seconds
---@return Playtime
function RecordSession(app_name, started_at, ended_at)
  local seconds = math.floor(ended_at - started_at)
  if seconds <= 0 then
    return combined(app_name)
  end

  local data = record.get()
  data.games = data.games or {}
  local game = data.games[app_name] or { seconds = 0 }
  game.seconds = game.seconds + seconds
  game.last_played = math.floor(ended_at)
  data.games[app_name] = game

  data.pending = data.pending or {}
  table.insert(
    data.pending,
    { app_name = app_name, started_at = math.floor(started_at), ended_at = game.last_played }
  )
  while #data.pending > MAX_PENDING do
    table.remove(data.pending, 1)
  end
  record.save()
  log.info("Played " .. app_name .. " for " .. seconds .. "s")

  flush()
  -- Epic's total now includes the session, if it took it
  refresh_totals()

  return combined(app_name)
end
