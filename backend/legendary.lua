--# selene: allow(unused_variable)
local cache = require("cache")
local fs = require("fs")
local jobs = require("jobs")
local json = require("json")
local log = require("log")
local shell = require("shell")
local utils = require("utils")
local vendor = require("vendor")

-- A wrapper around the `legendary` CLI (https://github.com/derrod/legendary),
-- which owns Epic's OAuth entirely - we never see a password or a token.

local legendary = {}

--- Epic's login, which lands on a page printing the authorization code.
local LOGIN_URL = "https://legendary.gl/epiclogin"

---@type string|nil
local binary_path = nil

---The legendary binary, downloaded on first use. Public because shortcuts launch
---legendary rather than the game's exe.
---@return string|nil path
---@return string? error
function legendary.get_binary()
  if binary_path and fs.is_file(binary_path) then
    return binary_path
  end

  local path, err = vendor.ensure()
  binary_path = path
  return path, err
end

---The subcommand out of one argument list, for a log line.
---@param args string[]
---@return string
local function subcommand(args)
  for _, arg in ipairs(args) do
    if arg:sub(1, 1) ~= "-" then
      return arg
    end
  end
  return "?"
end

---Run one legendary command and block until it exits.
---@param args string[] Arguments to legendary, unquoted
---@return string output stdout followed by stderr, empty if the binary is missing
---@return integer status -1 if there was nothing to run
function legendary.run(args)
  local binary, err = legendary.get_binary()
  if not binary then
    log.error("No legendary binary: " .. tostring(err))
    return "", -1
  end

  local started = utils.time_ms()
  local output, status = shell.run(binary, args)

  local summary = subcommand(args) .. " in " .. (utils.time_ms() - started) .. "ms"
  if status == 0 then
    log.info("Ran " .. summary)
  else
    log.warn("Ran " .. summary .. ", exited " .. status)
  end

  return output, status
end

---Is this one of legendary's own log lines, like "[cli] INFO: Logging in..."?
---@param trimmed string
---@return boolean
local function is_log_line(trimmed)
  return trimmed:match("^%[[%w%-%._]+%]%s+%u+:") ~= nil
end

---The last error line in some legendary output, if it printed one.
---@param output string
---@return string|nil
local function last_error(output)
  local last
  for line in output:gmatch("[^\r\n]+") do
    if line:find("ERROR:") or line:find("CRITICAL:") then
      last = utils.trim(line)
    end
  end
  return last
end

---Decode the JSON a legendary command printed.
---@param output string
---@return any|nil decoded
---@return string? error
function legendary.decode_json(output)
  -- Log lines like "[cli] INFO: ..." also start with "[", so they're skipped.
  local lines = utils.split(output, "\n")
  for index, line in ipairs(lines) do
    local trimmed = utils.trim(line)
    local opens = trimmed:sub(1, 1)
    if (opens == "{" or opens == "[") and not is_log_line(trimmed) then
      -- Stop at the next log line: stderr shares the pipe and can follow the document.
      local last = #lines
      for offset = index + 1, #lines do
        if is_log_line(utils.trim(lines[offset])) then
          last = offset - 1
          break
        end
      end

      local decoded = cache.decode(table.concat(lines, "\n", index, last))
      if decoded ~= nil then
        return decoded
      end
      return nil, "could not decode legendary output"
    end
  end

  -- Only the last error line, not the Python traceback a crash prints.
  return nil, last_error(output) or utils.trim(output):sub(1, 200)
end

---@class EpicStatus
---@field available boolean Is the binary present
---@field authenticated boolean Is there a logged in Epic account
---@field account string|nil Epic display name, when authenticated
---@field login_url string Where to send the user to sign in
---@field error string|nil Why we couldn't read a status, or why signing in failed

---@class LaunchCommand
---@field exe string
---@field arguments string
---@field start_dir string

--- Cached: reading it costs a subprocess, and every panel render checks it.
---@type EpicStatus|nil
local status = nil

---@param refresh boolean|nil Re-read rather than using the cached answer
---@return EpicStatus
function legendary.get_status(refresh)
  if status and not refresh then
    return status
  end

  local binary, err = legendary.get_binary()
  if not binary then
    status = {
      available = false,
      authenticated = false,
      login_url = LOGIN_URL,
      error = err,
    }
    return status
  end

  -- The only command that reports the account; prints "<not logged in>" for nobody.
  local output = legendary.run({ "status", "--json" })
  local decoded, decode_error = legendary.decode_json(output)

  local account = type(decoded) == "table" and decoded.account or nil
  if account == json.null or account == "<not logged in>" then
    account = nil
  end

  status = {
    available = true,
    authenticated = account ~= nil,
    account = account,
    login_url = LOGIN_URL,
    -- A decode complaint doesn't matter if the account came out anyway.
    error = account == nil and decode_error or nil,
  }

  log.info("Status: account=" .. tostring(account))
  return status
end

---@ffi
---Is legendary runnable, and is an Epic account signed in? Cached; pass `refresh`
---after anything that could change the answer.
---@param refresh? boolean
---@return EpicStatus
function GetStatus(refresh)
  return legendary.get_status(refresh)
end

---@ffi
---A game's shortcut command. It runs legendary, which waits on the game so playtime
---works, survives Epic moving the exe, and works before the game is installed.
---@param app_name string
---@return LaunchCommand|nil
function GetLaunchCommand(app_name)
  local binary = legendary.get_binary()
  if not binary then
    return nil
  end

  -- Steam shows these paths as given, so they get one style of separator.
  return {
    exe = shell.native_path(binary),
    arguments = 'launch "' .. app_name .. '"',
    start_dir = shell.native_path(fs.parent_path(binary)),
  }
end

---Queue a legendary command as a job.
---@param app_name string
---@param kind JobKind
---@param args string[]
---@return Job|nil
local function start_job(app_name, kind, args)
  local binary, err = legendary.get_binary()
  local job
  if binary then
    job, err = jobs.start(app_name, kind, binary, args)
  end

  if not job then
    log.warn("Could not start the " .. kind .. " of " .. app_name .. ": " .. tostring(err))
  end
  return job
end

---@ffi
---Install, update or resume a game; progress comes back through `GetJobs`.
---legendary's `install` resumes a partial download in place.
---@param app_name string
---@param base_path? string Parent directory to install into, legendary's default if nil
---@param game_folder? string Directory name inside it
---@return Job|nil
function StartInstall(app_name, base_path, game_folder)
  local args = { "-y", "install", app_name }

  if type(base_path) == "string" and base_path ~= "" then
    table.insert(args, "--base-path")
    table.insert(args, shell.native_path(base_path))
  end
  if type(game_folder) == "string" and game_folder ~= "" then
    table.insert(args, "--game-folder")
    table.insert(args, game_folder)
  end

  return start_job(app_name, "install", args)
end

---@ffi
---Update an installed game. `--update-only` refuses one that isn't installed
---rather than quietly installing it.
---@param app_name string
---@return Job|nil
function StartUpdate(app_name)
  return start_job(app_name, "update", { "-y", "install", app_name, "--update-only" })
end

---@ffi
---Remove a game from disk. The Steam shortcut is left alone, since keeping
---uninstalled games in the library is the point of the plugin.
---@param app_name string
---@return Job|nil
function StartUninstall(app_name)
  return start_job(app_name, "uninstall", { "-y", "uninstall", app_name })
end

-- Not `legendary auth --import`: Epic allows one session per client id, so it
-- would sign the user out of the Epic Games Launcher.

---@ffi
---Finish a sign in with the code from Epic's redirect page; `error` is set on
---failure. legendary exits 0 either way, so success is read from its status.
---@param code string The authorizationCode from Epic's redirect page
---@return EpicStatus
function SignIn(code)
  log.info("Signing in with a code from the store's session")
  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  local current = legendary.get_status(true)
  if current.authenticated then
    return current
  end

  -- A copy, so the error doesn't stick to the cached status.
  local result = utils.merge({}, current)
  -- legendary clears the stored login before trying a code, so a bad one signs out.
  result.error = last_error(output)
    or "That code didn't work, it may have expired or already been used. Press Sign in for a fresh one."
  return result
end

---@ffi
---Sign out, so the next sign in starts clean.
---@return EpicStatus
function SignOut()
  log.info("Signing out, the store is signed out")
  legendary.run({ "auth", "--delete" })
  return legendary.get_status(true)
end

return legendary
