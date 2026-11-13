--# selene: allow(unused_variable)
local datetime = require("datetime")
local json = require("json")
local legendary = require("epic.legendary")
local log = require("core.log")
local utils = require("utils")
local vendor = require("epic.vendor")

-- Epic's login lands on a page printing the authorization code
local LOGIN_URL = "https://legendary.gl/epiclogin"

local account = {}

---@class EpicStatus
---@field available boolean
---@field authenticated boolean
---@field account string|nil Display name
---@field login_url string
---@field error string|nil
---@field pending boolean|nil Not known yet, as legendary is downloading or being asked

-- The last answer, as reading it costs a run of legendary and every panel render checks it
---@type EpicStatus|nil
local status = nil

local STATUS = "status"

-- A legendary that didn't answer is asked again this often, as the panel polls the status
local RETRY_SECONDS = 30
local read_at = 0

-- Set when signing in or out overtakes a read already running, whose answer is then old
local discard = false

-- The only command that reports the account, and it prints "<not logged in>" for nobody
-- Prints nothing when it can't reach Epic, where --offline still reads the stored login
local ONLINE = { "status", "--json" }
local OFFLINE = { "status", "--offline", "--json" }

---@param error string|nil
---@return EpicStatus
local function pending(error)
  return {
    available = false,
    authenticated = false,
    login_url = LOGIN_URL,
    pending = true,
    error = error,
  }
end

---@param online string
---@param offline string|nil Only needed if online printed nothing usable
---@return EpicStatus
local function parse(online, offline)
  local decoded, decode_error = legendary.decode_json(online)
  if type(decoded) ~= "table" and offline then
    decoded = legendary.decode_json(offline) or decoded
  end

  -- A crash or a hung run, which mustn't pass for being signed out
  if type(decoded) ~= "table" then
    log.warn("Status unreadable: " .. tostring(decode_error))
    return {
      available = false,
      authenticated = false,
      login_url = LOGIN_URL,
      error = "legendary didn't answer: " .. tostring(decode_error),
    }
  end

  local name = decoded.account
  if name == json.null or name == "<not logged in>" then
    name = nil
  end

  log.info("Status: account=" .. tostring(name))
  return {
    available = true,
    authenticated = name ~= nil,
    account = name,
    login_url = LOGIN_URL,
  }
end

---Never waits on legendary: the first call starts reading the status and answers pending, and
---a later one picks the answer up
---@param refresh boolean|nil Read it again, still answering with the last one meanwhile
---@return EpicStatus
function account.status(refresh)
  local asked = refresh
  local outputs = legendary.collect(STATUS)
  if outputs and discard then
    discard = false
  elseif outputs then
    status = parse(outputs[1], outputs[2])
    read_at = datetime.unix()
    refresh = false
  end

  if status and not status.available and datetime.unix() - read_at > RETRY_SECONDS then
    refresh = true
  end

  if (status and not refresh) or legendary.is_running(STATUS) then
    return status or pending()
  end

  if asked then
    vendor.retry()
  end

  local started, err, downloading = legendary.start(STATUS, { ONLINE, OFFLINE })
  if started or downloading then
    return status or pending(err)
  end

  status = { available = false, authenticated = false, login_url = LOGIN_URL, error = err }
  read_at = datetime.unix()
  return status
end

---Waits on legendary, for signing in and out, whose callers need the answer it leads to
---@return EpicStatus
local function read_now()
  local binary, err = legendary.get_binary()
  if not binary then
    return status or pending(err)
  end

  discard = legendary.is_running(STATUS)
  local online = legendary.run(ONLINE)
  local offline = legendary.decode_json(online) == nil and legendary.run(OFFLINE) or nil
  status = parse(online, offline)
  read_at = datetime.unix()
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
  code = type(code) == "string" and utils.trim(code) or ""
  if not code:match("^%x+$") then
    local result = utils.merge({}, account.status())
    result.error = "That wasn't an authorization code from Epic."
    return result
  end

  log.info("Signing in with a code from the store's session")
  local output = legendary.run({ "auth", "--code", code })
  local current = read_now()
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
  return read_now()
end

return account
