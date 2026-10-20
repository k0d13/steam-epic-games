--# selene: allow(unused_variable)
local cache = require("core.cache")
local datetime = require("datetime")
local legendary = require("epic.legendary")
local log = require("core.log")
local paths = require("core.paths")

-- These go stale as the user plays, so fetched_at lets the frontend decide when to ask again

---@class Achievement
---@field id string Epic's internal name, unique within the game
---@field name string
---@field description string
---@field unlocked boolean
---@field progress number 0 to 1
---@field unlocked_at string|nil Like "2026-06-12 21:21:24.391000+00:00"
---@field icon string|nil Already locked or unlocked as appropriate
---@field rarity number|nil Percent of players holding it
---@field hidden boolean Undiscovered, so Steam blurs it

---@class GameAchievements
---@field total integer
---@field unlocked integer
---@field fetched_at integer Unix seconds
---@field achievements Achievement[]

---@class AchievementSummary
---@field app_name string
---@field total integer
---@field unlocked integer
---@field fetched_at integer Unix seconds

local store = cache.open(paths.DATA .. "/cache/achievements.json", "achievements")

---@param entries table[]|nil One of legendary's four buckets
---@param out Achievement[]
local function collect(entries, out)
  if type(entries) ~= "table" then
    return
  end

  for _, entry in ipairs(entries) do
    table.insert(out, {
      id = entry.name,
      name = entry.display_name or entry.name,
      description = entry.description or "",
      unlocked = entry.unlocked == true,
      progress = entry.progress or 0,
      unlocked_at = type(entry.unlock_date) == "string" and entry.unlock_date or nil,
      icon = entry.icon_link,
      rarity = (entry.rarity or {}).percent,
      hidden = entry.hidden == true,
    })
  end
end

---@param decoded table A `legendary achievements --json` document
---@return GameAchievements
local function build(decoded)
  local list = {}
  -- Steam's order: unlocked, in progress, then the rest
  collect(decoded.completed, list)
  collect(decoded.in_progress, list)
  collect(decoded.uninitiated, list)
  collect(decoded.hidden, list)

  return {
    total = decoded.total_achievements or #list,
    unlocked = decoded.user_unlocked or 0,
    fetched_at = datetime.unix(),
    achievements = list,
  }
end

---@ffi
---Forgets every game's achievements, so the next read asks Epic again
function ClearAchievements()
  store.clear()
end

---@ffi
---A miss costs a round trip to Epic
---@param app_name string
---@param refresh? boolean Ask Epic again even if it's cached
---@return GameAchievements|nil
function GetAchievements(app_name, refresh)
  local cached = store.get()
  if cached[app_name] and not refresh then
    return cached[app_name]
  end

  -- --hidden, as Steam blurs undiscovered ones itself and its counts need them
  local output = legendary.run({ "achievements", app_name, "--json", "--hidden" })
  local decoded, err = legendary.decode_json(output)

  -- None comes as a log line, not a document, and is cached anyway or every session asks again
  if type(decoded) ~= "table" and output:find("No achievements found", 1, true) then
    decoded = {}
  elseif type(decoded) ~= "table" then
    log.warn("Could not read achievements for " .. app_name .. ": " .. tostring(err))
    return nil
  end

  local result = build(decoded)
  cached[app_name] = result
  store.save()

  log.info("Read achievements for " .. app_name .. ": " .. result.unlocked .. "/" .. result.total)
  return result
end

---@ffi
---Without asking Epic, for the library's "% of Achievements Completed" sort
---@return AchievementSummary[]
function GetCachedAchievements()
  local summaries = {}
  for app_name, entry in pairs(store.get()) do
    table.insert(summaries, {
      app_name = app_name,
      total = entry.total,
      unlocked = entry.unlocked,
      fetched_at = entry.fetched_at,
    })
  end

  return summaries
end
