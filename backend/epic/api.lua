local account = require("epic.account")
local cache = require("core.cache")
local datetime = require("datetime")
local entitlements = require("epic.entitlements")
local http = require("http")
local log = require("core.log")
local paths = require("core.paths")

-- Epic's web services, called as the account legendary is signed in to

-- A token this close to expiring is refreshed first, so a request can't outlive it
local EXPIRY_MARGIN = 5 * 60

local api = {}

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

---@return string|nil account_id Nil when signed out
function api.account_id()
  local user = signed_in()
  return user and user.account_id or nil
end

---With the bearer token, and once more on a fresh one if Epic turns the first down
---@param url string
---@param options? { method?: string, data?: string, headers?: table<string, string> }
---@return table|nil response Nil when signed out or unreachable
function api.request(url, options)
  options = options or {}

  local response
  for attempt = 1, 2 do
    local user = signed_in(attempt == 2)
    if not user then
      return nil
    end

    local headers = { ["Content-Type"] = "application/json" }
    for name, value in pairs(options.headers or {}) do
      headers[name] = value
    end
    headers.Authorization = "bearer " .. user.access_token

    local err
    response, err = http.request(url, {
      method = options.method or "GET",
      data = options.data,
      headers = headers,
      timeout = 10,
    })
    if not response then
      log.warn("Could not reach " .. url .. ": " .. tostring(err))
      return nil
    end

    -- Revoked or expired early, so it's worth one refresh
    if response.status ~= 401 then
      break
    end
  end

  return response
end

---@param url string
---@param options? { method?: string, data?: string, headers?: table<string, string> }
---@return table|nil decoded Nil unless Epic answered 200 with JSON
function api.json(url, options)
  local response = api.request(url, options)
  local decoded = response and response.status == 200 and cache.decode(response.body) or nil
  if response and not decoded then
    log.warn(url .. " answered " .. response.status)
  end
  return decoded
end

return api
