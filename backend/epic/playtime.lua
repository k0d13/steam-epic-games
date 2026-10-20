local account = require("epic.account")
local cache = require("core.cache")
local datetime = require("datetime")
local entitlements = require("epic.entitlements")
local http = require("http")
local json = require("json")
local log = require("core.log")
local paths = require("core.paths")

-- Epic's own play time record, which only launchers that report sessions add to: the
-- Epic Games Launcher does, legendary doesn't, so we report Steam's sessions ourselves.
-- Neither endpoint is documented; both are the ones the launcher uses

local PLAYTIME_URL =
  "https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/"

-- A token this close to expiring is refreshed first, so a request can't outlive it
local EXPIRY_MARGIN = 5 * 60

local playtime = {}

---legendary's session, which it refreshes itself; we only read it
---@return table|nil user
local function session()
  local user = cache.read(paths.legendary_config() .. "/user.json", "session")
  if type(user) ~= "table" or type(user.access_token) ~= "string" then
    return nil
  end
  return user
end

---A usable session, refreshed through legendary when it's about to expire
---@param force boolean|nil Refresh even if it looks valid, after Epic turned it down
---@return table|nil user
local function signed_in(force)
  local user = session()
  if not user then
    return nil
  end

  local expires_at = entitlements.parse_date(user.expires_at)
  if force or not expires_at or expires_at - datetime.unix() < EXPIRY_MARGIN then
    -- legendary's status logs in first, which refreshes the stored session
    account.status(true)
    user = session()
  end

  return user
end

---@param method string
---@param body string|nil
---@return HTTPResponse|nil response
local function request(method, body)
  local response
  for attempt = 1, 2 do
    local user = signed_in(attempt == 2)
    if not user then
      return nil
    end

    local url = PLAYTIME_URL .. user.account_id .. (method == "GET" and "/all" or "")
    local err
    response, err = http.request(url, {
      method = method,
      data = body,
      headers = {
        Authorization = "bearer " .. user.access_token,
        ["Content-Type"] = "application/json",
      },
      timeout = 10,
    })
    if not response then
      log.warn("Could not reach Epic's play time: " .. tostring(err))
      return nil
    end

    -- Revoked or expired early, so it's worth one refresh
    if response.status ~= 401 then
      break
    end
  end

  return response
end

---Seconds played per app name, as Epic has them
---@return table<string, integer>|nil
function playtime.totals()
  local response = request("GET")
  local decoded = response and response.status == 200 and cache.decode(response.body) or nil
  if type(decoded) ~= "table" then
    if response then
      log.warn("Epic's play time answered " .. response.status)
    end
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
  local response = request(
    "PUT",
    json.encode({
      machineId = machine_id,
      artifactId = app_name,
      startTime = iso(started_at),
      endTime = iso(ended_at),
    })
  )
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
