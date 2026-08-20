local fs = require("fs")
local json = require("json")
local logger = require("logger")
local utils = require("utils")
local vendor = require("vendor")

-- A wrapper around the `legendary` CLI (https://github.com/derrod/legendary),
-- which owns Epic's OAuth entirely - we never see a password or a token.

local legendary = {}

--- Where Epic sends the user to log in. The page it lands on prints the
--- authorization code we need.
local LOGIN_URL = "https://legendary.gl/epiclogin"

---@type string|nil
local BINARY = nil

---The legendary binary, downloading it if this machine hasn't got it yet.
---Public because a shortcut points at it - Steam launches legendary, not the
---game's own exe.
---@return string|nil path
---@return string? error
function legendary.get_binary()
  if BINARY and fs.is_file(BINARY) then return BINARY end

  local path, err = vendor.ensure()
  BINARY = path
  return path, err
end

-- Commands --------------------------------------------------------------------

---Quote a single argument for cmd.exe.
---@param arg string
---@return string
local function quote(arg)
  return '"' .. arg:gsub('"', '\\"') .. '"'
end

--- Printed between commands in a batch so their output can be told apart. Long
--- enough that legendary can't print it by accident.
local SEPARATOR = "--epic-games-plugin-next--"

---The subcommand out of one argument list, for a log line.
---@param args string[]
---@return string
local function subcommand(args)
  for _, arg in ipairs(args) do
    if arg:sub(1, 1) ~= "-" then return arg end
  end
  return "?"
end

---Run several legendary commands, in order, behind one terminal flash.
---
---Every exec flashes a terminal on screen, since legendary is a console
---application and Steam has no console. Batching is the only way to have fewer
---of them: one per user action instead of one per command.
---@param arg_lists string[][] Arguments to legendary, unquoted, one list per command
---@return string[] outputs stdout and stderr together, one per command, empty if the binary is missing
---@return integer status Exit status of the last command, since cmd's chaining loses the rest, or -1 if there was nothing to run
function legendary.run_batch(arg_lists)
  local outputs = {}
  for index = 1, #arg_lists do
    outputs[index] = ""
  end

  local binary, err = legendary.get_binary()
  if not binary then
    logger:error("No legendary binary: " .. tostring(err))
    return outputs, -1
  end

  local commands = {}
  local names = {}
  for index, args in ipairs(arg_lists) do
    local parts = { quote(binary) }
    for _, arg in ipairs(args) do
      table.insert(parts, quote(arg))
    end

    -- legendary writes its log lines and its errors to stderr, which popen
    -- doesn't capture on its own.
    commands[index] = table.concat(parts, " ") .. " 2>&1"

    names[index] = subcommand(args)
  end

  -- `&`, not `&&`: one failure in the middle shouldn't drop the rest.
  local line = table.concat(commands, " & echo " .. SEPARATOR .. " & ")

  -- Wrapped in one more pair of quotes: this runs through `cmd /c`, which
  -- strips the outermost pair before parsing. Without it the path to the binary
  -- loses its quotes and splits at its first space.
  local started = utils.time_ms()
  local output, status = utils.exec('"' .. line .. '"')
  local elapsed = utils.time_ms() - started

  -- The full line is only worth logging when something failed.
  status = tonumber(status) or -1
  local summary = utils.join(names, ", ") .. " in " .. elapsed .. "ms"
  if status == 0 then
    logger:info("Ran " .. summary)
  else
    logger:warn("Ran " .. summary .. ", exited " .. status .. ": " .. line)
  end

  -- Split by hand: utils.split takes its delimiter a character at a time and
  -- would cut this up at every dash.
  local remaining = output or ""
  for index = 1, #arg_lists do
    local from, to = remaining:find(SEPARATOR, 1, true)
    if not from then
      outputs[index] = remaining
      break
    end

    outputs[index] = remaining:sub(1, from - 1)
    remaining = remaining:sub(to + 1)
  end

  return outputs, status
end

---Run one legendary command and block until it exits.
---@param args string[] Arguments to legendary, unquoted
---@return string output stdout and stderr together, empty if the binary is missing
---@return integer status -1 if there was nothing to run
function legendary.run(args)
  local outputs, status = legendary.run_batch({ args })
  return outputs[1] or "", status
end

---Decode the JSON a legendary command printed.
---@param output string
---@return any|nil decoded
---@return string? error
function legendary.decode_json(output)
  -- The JSON arrives with legendary's log lines mixed in, and those look like
  -- "[cli] INFO: Logging in..." - so a search for the first "[" finds a log
  -- line, not the document.
  local lines = utils.split(output, "\n")
  for index, line in ipairs(lines) do
    local trimmed = utils.trim(line)
    local opens = trimmed:sub(1, 1)
    if (opens == "{" or opens == "[") and not trimmed:match("^%[[%w%-%._]+%]%s+%u+:") then
      local ok, decoded = pcall(json.decode, table.concat(lines, "\n", index))
      if ok then return decoded end
      return nil, "could not decode legendary output: " .. tostring(decoded)
    end
  end

  return nil, utils.trim(output)
end

---The last error line in some legendary output, if it printed one.
---@param output string
---@return string|nil
function legendary.last_error(output)
  local last
  for line in output:gmatch("[^\r\n]+") do
    if line:find("ERROR:") or line:find("CRITICAL:") then last = utils.trim(line) end
  end
  return last
end

-- Status ----------------------------------------------------------------------

---@class LegendaryStatus
---@field available boolean Is the binary present
---@field authenticated boolean Is there a logged in Epic account
---@field account string|nil Epic display name, when authenticated
---@field login_url string Where to send the user to sign in
---@field error string|nil Why we couldn't read a status

--- Cached: reading it costs a subprocess and a terminal flash, and it's checked
--- on every panel render.
---@type LegendaryStatus|nil
local status = nil

---@param refresh boolean|nil Re-read rather than using the cached answer
---@return LegendaryStatus
function legendary.get_status(refresh)
  if status and not refresh then return status end

  local binary, err = legendary.get_binary()
  if not binary then
    status = {
      available = false,
      authenticated = false,
      login_url = LOGIN_URL,
      error = err or "legendary could not be downloaded.",
    }
    return status
  end

  -- The only command that reports the logged in account. It answers
  -- "<not logged in>" rather than failing when nobody is.
  local output = legendary.run({ "status", "--json" })
  local decoded, err = legendary.decode_json(output)

  local account = type(decoded) == "table" and decoded.account or nil
  if account == json.null or account == "<not logged in>" then account = nil end

  status = {
    available = true,
    authenticated = account ~= nil,
    account = account,
    login_url = LOGIN_URL,
    error = err,
  }

  logger:info("Status: account=" .. tostring(account))
  return status
end

-- Authentication --------------------------------------------------------------

-- `legendary auth --import` would lift a login out of the Epic Games Launcher
-- with no browser at all, but Epic allows one session per client id: importing
-- signs the user out of the launcher. Not something to do behind their back.

---Finish a sign in with the code from Epic's redirect page.
---
---`--code` is the non-interactive form. Plain `legendary auth` blocks on stdin
---waiting for the code, and there is no stdin here.
---
---legendary exits 0 even when a login fails, so success is read by asking it who
---it thinks we are afterwards.
---@param code string The authorizationCode from Epic's redirect page
---@return boolean success
---@return string? error
function legendary.authenticate(code)
  if type(code) ~= "string" or utils.trim(code) == "" then return false, "No code provided" end

  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  if legendary.get_status(true).authenticated then return true end

  -- A failed attempt is not a no-op: legendary clears the stored login before
  -- trying the new code, so a bad code signs the user out. Hence the wording.
  return false,
      legendary.last_error(output)
      or "That code didn't work, it may have expired or already been used. Press Sign in for a fresh one."
end

---Sign out, so the next sign in starts clean.
---@return boolean success
function legendary.sign_out()
  legendary.run({ "auth", "--delete" })
  return not legendary.get_status(true).authenticated
end

return legendary
