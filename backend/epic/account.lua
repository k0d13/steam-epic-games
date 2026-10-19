--# selene: allow(unused_variable)
local json = require("json")
local legendary = require("epic.legendary")
local log = require("core.log")
local utils = require("utils")

-- Epic's login lands on a page printing the authorization code
local LOGIN_URL = "https://legendary.gl/epiclogin"

local account = {}

---@class EpicStatus
---@field available boolean
---@field authenticated boolean
---@field account string|nil Display name
---@field login_url string
---@field error string|nil

-- Cached, as reading it costs a subprocess and every panel render checks it
---@type EpicStatus|nil
local status = nil

---@param refresh boolean|nil
---@return EpicStatus
function account.status(refresh)
  if status and not refresh then
    return status
  end

  local binary, err = legendary.get_binary()
  if not binary then
    status = { available = false, authenticated = false, login_url = LOGIN_URL, error = err }
    return status
  end

  -- The only command that reports the account, and it prints "<not logged in>" for nobody
  local decoded, decode_error = legendary.decode_json(legendary.run({ "status", "--json" }))

  local name = type(decoded) == "table" and decoded.account or nil
  if name == json.null or name == "<not logged in>" then
    name = nil
  end

  status = {
    available = true,
    authenticated = name ~= nil,
    account = name,
    login_url = LOGIN_URL,
    -- A decode complaint doesn't matter if the account came out anyway
    error = name == nil and decode_error or nil,
  }

  log.info("Status: account=" .. tostring(name))
  return status
end

---@ffi
---Cached, so pass refresh after anything that could change the answer
---@param refresh? boolean
---@return EpicStatus
function GetStatus(refresh)
  return account.status(refresh)
end

-- Not legendary auth --import, as Epic allows one session per client id and that
-- would sign the user out of the Epic Games Launcher

---@ffi
---legendary exits 0 either way, so success is read from its status
---@param code string The authorizationCode from Epic's redirect page
---@return EpicStatus
function SignIn(code)
  log.info("Signing in with a code from the store's session")
  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  local current = account.status(true)
  if current.authenticated then
    return current
  end

  -- A copy, so the error doesn't stick to the cached status
  local result = utils.merge({}, current)
  -- legendary clears the stored login before trying a code, so a bad one signs out
  result.error = legendary.last_error(output)
    or "That code didn't work, it may have expired or already been used. Press Sign in for a fresh one."
  return result
end

---@ffi
---@return EpicStatus
function SignOut()
  log.info("Signing out, the store is signed out")
  legendary.run({ "auth", "--delete" })
  return account.status(true)
end

return account
