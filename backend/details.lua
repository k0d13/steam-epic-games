--# selene: allow(unused_variable)
local cache = require("cache")
local datetime = require("datetime")
local legendary = require("legendary")
local log = require("log")
local paths = require("paths")

-- One game's size and achievements, each a legendary run, so both are cached per game.

-- Steam's "Space Required", one manifest fetch per game and cached with no way to
-- tell it's stale, so the frontend drops a game's size when a job touches it.

---@class GameSize
---@field disk integer Bytes the installed game occupies - what Steam calls "Space Required"
---@field download integer Bytes actually transferred, which is smaller: Epic ships compressed

local SIZES_PATH = paths.DATA .. "/cache/sizes.json"

---@type table<string, GameSize>|nil
local sizes = nil

---@ffi
---What one game needs on disk. A miss costs a manifest fetch from Epic.
---@param app_name string
---@param refresh? boolean Re-read even if it's cached
---@return GameSize|nil
function GetGameSize(app_name, refresh)
  sizes = sizes or cache.read(SIZES_PATH, "sizes") or {}
  -- A negative size was wrapped by the Linux decoder before cache.decode fixed it.
  if sizes[app_name] and sizes[app_name].disk >= 0 and not refresh then
    return sizes[app_name]
  end

  local decoded, err = legendary.decode_json(legendary.run({ "info", app_name, "--json" }))
  -- No manifest means legendary could not reach Epic.
  local manifest = type(decoded) == "table" and decoded.manifest or nil
  if type(manifest) ~= "table" or type(manifest.disk_size) ~= "number" then
    log.warn("Could not size " .. app_name .. ": " .. tostring(err))
    return nil
  end

  sizes[app_name] = {
    disk = manifest.disk_size,
    download = manifest.download_size or manifest.disk_size,
  }
  cache.write(SIZES_PATH, sizes, "sizes")

  log.info("Sized " .. app_name .. ": " .. manifest.disk_size .. " bytes on disk")
  return sizes[app_name]
end

-- Cached per game like sizes, but these go stale as the user plays, so `fetched_at`
-- lets the frontend decide when to ask again.

local ACHIEVEMENTS_PATH = paths.DATA .. "/cache/achievements.json"

---@class Achievement
---@field id string Epic's internal name, unique within the game
---@field name string Display name
---@field description string
---@field unlocked boolean
---@field progress number 0 to 1
---@field unlocked_at string|nil Epic's timestamp, like "2026-06-12 21:21:24.391000+00:00"
---@field icon string|nil Icon URL, already locked or unlocked as appropriate
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

---@type table<string, GameAchievements>|nil
local achievements = nil

---Every cached game's achievements, read off disk the first time.
---@return table<string, GameAchievements>
local function load_achievements()
  achievements = achievements or cache.read(ACHIEVEMENTS_PATH, "achievements") or {}
  return achievements
end

---Flatten one of legendary's four buckets into our own shape.
---@param entries table[]|nil
---@param out Achievement[]
local function collect_achievements(entries, out)
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

---Turn one `legendary achievements --json` document into a GameAchievements.
---@param decoded table
---@return GameAchievements
local function build_achievements(decoded)
  local list = {}
  -- Steam's order: unlocked, in progress, then the rest.
  collect_achievements(decoded.completed, list)
  collect_achievements(decoded.in_progress, list)
  collect_achievements(decoded.uninitiated, list)
  collect_achievements(decoded.hidden, list)

  return {
    total = decoded.total_achievements or #list,
    unlocked = decoded.user_unlocked or 0,
    fetched_at = datetime.unix(),
    achievements = list,
  }
end

---@ffi
---One game's achievements. A miss costs a round trip to Epic.
---@param app_name string
---@param refresh? boolean Ask Epic again even if it's cached
---@return GameAchievements|nil
function GetAchievements(app_name, refresh)
  local cached = load_achievements()
  if cached[app_name] and not refresh then
    return cached[app_name]
  end

  -- --hidden, since Steam blurs undiscovered ones itself and its counts need them.
  local output = legendary.run({ "achievements", app_name, "--json", "--hidden" })
  local decoded, err = legendary.decode_json(output)

  -- "None" comes as a log line, not a document. Cached anyway, or every session asks again.
  if type(decoded) ~= "table" and output:find("No achievements found", 1, true) then
    decoded = {}
  elseif type(decoded) ~= "table" then
    log.warn("Could not read achievements for " .. app_name .. ": " .. tostring(err))
    return nil
  end

  local result = build_achievements(decoded)
  cached[app_name] = result
  cache.write(ACHIEVEMENTS_PATH, cached, "achievements")

  log.info("Read achievements for " .. app_name .. ": " .. result.unlocked .. "/" .. result.total)
  return result
end

---@ffi
---Cached achievement counts for every game, without asking Epic, for the library's
---"% of Achievements Completed" sort.
---@return AchievementSummary[]
function GetCachedAchievements()
  local summaries = {}
  for app_name, entry in pairs(load_achievements()) do
    table.insert(summaries, {
      app_name = app_name,
      total = entry.total,
      unlocked = entry.unlocked,
      fetched_at = entry.fetched_at,
    })
  end

  return summaries
end
