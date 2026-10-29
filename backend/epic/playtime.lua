local api = require("epic.api")
local datetime = require("datetime")
local json = require("json")
local log = require("core.log")

-- Epic's play time record, which legendary doesn't report to as the launcher does, so we report
-- Steam's sessions ourselves; both endpoints are the launcher's own, and undocumented

local PLAYTIME_URL =
  "https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/"

local playtime = {}

---Seconds played per app name, as Epic has them
---@return table<string, integer>|nil
function playtime.totals()
  local account_id = api.account_id()
  local decoded = account_id and api.json(PLAYTIME_URL .. account_id .. "/all")
  if type(decoded) ~= "table" then
    return nil
  end

  local totals = {}
  for _, entry in ipairs(decoded) do
    if type(entry.artifactId) == "string" and type(entry.totalTime) == "number" then
      totals[entry.artifactId] = math.floor(entry.totalTime)
    end
  end
  return totals
end

---@param seconds integer
local function iso(seconds)
  return datetime.format(datetime.from_unix(seconds), "%Y-%m-%dT%H:%M:%S.000Z", true)
end

---Adds one session to Epic's total
---@param machine_id string
---@param app_name string
---@param started_at integer Unix seconds
---@param ended_at integer Unix seconds
---@return boolean done False to try again later
function playtime.report(machine_id, app_name, started_at, ended_at)
  local account_id = api.account_id()
  local response = account_id
    and api.request(PLAYTIME_URL .. account_id, {
      method = "PUT",
      data = json.encode({
        machineId = machine_id,
        artifactId = app_name,
        startTime = iso(started_at),
        endTime = iso(ended_at),
      }),
    })
  if not response then
    return false
  end

  if response.status >= 200 and response.status < 300 then
    log.info("Reported " .. (ended_at - started_at) .. "s of " .. app_name .. " to Epic")
    return true
  end

  log.warn("Epic turned down a session of " .. app_name .. ": " .. response.status)
  -- Signed out or a server error is worth repeating; anything else would be turned down again
  return response.status ~= 401 and response.status < 500
end

return playtime
