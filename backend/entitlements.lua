local fs = require("fs")
local json = require("json")
local logger = require("logger")
local utils = require("utils")

-- When an account was granted a game, which is the closest thing Epic has to
-- Steam's purchase date. `legendary list` doesn't carry it, but legendary keeps
-- the entitlements it fetches alongside its own catalog cache, refreshed by the
-- same `list` we already run, so it is read straight off disk here.
--
-- Entitlements are keyed by namespace rather than by app: a game and its DLC
-- share one, so the earliest grant in a namespace is the base game's.

local entitlements = {}

---Where legendary keeps its config and caches.
---@return string
local function config_path()
  local override = utils.getenv("LEGENDARY_CONFIG_PATH")
  if override and override ~= "" then
    return override
  end

  local xdg = utils.getenv("XDG_CONFIG_HOME")
  if xdg and xdg ~= "" then
    return xdg .. "/legendary"
  end

  -- legendary expands `~` itself, which on Windows is the user profile.
  local home = utils.getenv("USERPROFILE")
  if not home or home == "" then
    home = utils.getenv("HOME") or ""
  end

  return home .. "/.config/legendary"
end

---Unix seconds out of one "2020-12-09T14:25:48.859Z" grant date. Always UTC, so
---the arithmetic is done here rather than through `os.time`, which reads a date
---table as local time.
---@param value string|nil
---@return integer|nil seconds
local function parse_granted(value)
  if type(value) ~= "string" then
    return nil
  end

  local year, month, day, hour, minute, second = value:match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
  if not year then
    return nil
  end

  -- Days from the civil epoch, Howard Hinnant's algorithm: it needs no table of
  -- month lengths and gets leap years right on its own.
  year, month, day = tonumber(year), tonumber(month), tonumber(day)
  local era_year = month <= 2 and year - 1 or year
  local era = math.floor(era_year / 400)
  local year_of_era = era_year - era * 400
  local day_of_year = math.floor((153 * (month + (month > 2 and -3 or 9)) + 2) / 5) + day - 1
  local day_of_era = year_of_era * 365
    + math.floor(year_of_era / 4)
    - math.floor(year_of_era / 100)
    + day_of_year
  local days = era * 146097 + day_of_era - 719468

  return days * 86400 + tonumber(hour) * 3600 + tonumber(minute) * 60 + tonumber(second)
end

---The earliest grant date per Epic namespace, in Unix seconds.
---@return table<string, integer> granted_by_namespace
function entitlements.get_granted()
  local path = config_path() .. "/entitlements.json"
  if not fs.is_file(path) then
    logger:info("No legendary entitlements at " .. path)
    return {}
  end

  local ok, decoded = pcall(json.decode, utils.read_file(path) or "")
  if not ok or type(decoded) ~= "table" then
    logger:warn("Unreadable legendary entitlements at " .. path)
    return {}
  end

  local granted = {}
  for _, entitlement in ipairs(decoded) do
    local namespace = entitlement.namespace
    local at = parse_granted(entitlement.grantDate)
    if
      type(namespace) == "string"
      and at
      and (not granted[namespace] or at < granted[namespace])
    then
      granted[namespace] = at
    end
  end

  return granted
end

return entitlements
