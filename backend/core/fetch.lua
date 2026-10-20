local cache = require("core.cache")
local http = require("http")
local log = require("core.log")

local fetch = {}

---@param url string
---@return table|nil document
---@return boolean missing The server answered, and it has no such page
function fetch.json(url)
  local response, err = http.get(url, { timeout = 10 })
  if not response then
    log.warn("Could not reach " .. url .. ": " .. tostring(err))
    return nil, false
  end

  if response.status == 404 then
    return nil, true
  end

  local decoded = response.status == 200 and cache.decode(response.body) or nil
  if type(decoded) ~= "table" then
    log.warn(url .. " answered " .. response.status)
  end
  return decoded, false
end

return fetch
