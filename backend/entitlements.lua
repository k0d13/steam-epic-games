local cache = require("cache")
local paths = require("paths")

-- Grant dates stand in for Steam's purchase date, read from legendary's on-disk
-- cache. A game shares its namespace with its DLC, so the earliest grant is the game's.

local entitlements = {}

---Unix seconds from a UTC grant date like "2020-12-09T14:25:48.859Z". Not through
---`os.time`, which reads a date table as local time.
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

  -- Howard Hinnant's days_from_civil.
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
  local granted = {}
  for _, entitlement in
    ipairs(
      cache.read(paths.legendary_config() .. "/entitlements.json", "legendary entitlements") or {}
    )
  do
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
