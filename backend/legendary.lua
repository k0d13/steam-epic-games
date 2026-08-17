local fs = require("fs")
local json = require("json")
local logger = require("logger")
local utils = require("utils")

-- Everything here is a wrapper around the `legendary` CLI
-- (https://github.com/derrod/legendary), which owns Epic's OAuth entirely - we
-- never see a password or a token.

local legendary = {}

--- Where Epic sends the user to log in. legendary owns this redirect, and the
--- page it lands on prints the authorization code we need.
local LOGIN_URL = "https://legendary.gl/epiclogin"

--- The legendary build shipped with this plugin. Downloaded at build time by
--- scripts/fetch-legendary.mjs from a pinned upstream release, verified against a
--- recorded SHA-256, and shipped inside the plugin - nothing is fetched at
--- runtime, so the plugin never pulls an executable onto a user's machine.
--- get_backend_path() is the backend directory itself, not a file inside it, so
--- this hangs directly off it. See backend/vendor/LICENSE - legendary is GPL-3.0.
local BINARY = utils.get_backend_path() .. "/vendor/legendary.exe"

---The shipped legendary binary, or nil if it isn't there. Public because a
---shortcut points *at* it - Steam launches legendary, not the game's own exe.
---@return string|nil path
function legendary.get_binary()
  if not fs.is_file(BINARY) then return nil end
  return BINARY
end

-- Commands --------------------------------------------------------------------

---Quote a single argument for cmd.exe.
---@param arg string
---@return string
local function quote(arg)
  return '"' .. arg:gsub('"', '\\"') .. '"'
end

--- Printed between commands in a batch so their output can be told apart. Long
--- enough that nothing legendary prints can be mistaken for it - a false match
--- would split one command's JSON in half.
local SEPARATOR = "--epic-games-plugin-next--"

---Run several legendary commands, in order, behind one terminal flash.
---
---legendary is a console application and Steam is a GUI process with no console,
---so every exec flashes a terminal on screen, and Millennium has no way to start
---a process without one. The only lever left is to call it less: one exec per
---user action rather than one per command.
---@param arg_lists string[][] Arguments to legendary, unquoted, one list per command
---@return string[] outputs stdout and stderr together, one per command, empty if the binary is missing
---@return integer status Exit status of the last command - cmd's chaining loses the rest - or -1 if there was nothing to run
function legendary.run_batch(arg_lists)
  local outputs = {}
  for index = 1, #arg_lists do
    outputs[index] = ""
  end

  if not fs.is_file(BINARY) then
    logger:error("No legendary binary at " .. BINARY)
    return outputs, -1
  end

  local commands = {}
  for index, args in ipairs(arg_lists) do
    local parts = { quote(BINARY) }
    for _, arg in ipairs(args) do
      table.insert(parts, quote(arg))
    end

    -- 2>&1 because legendary writes its own log lines, and every error worth
    -- showing the user, to stderr - which popen doesn't capture on its own.
    commands[index] = table.concat(parts, " ") .. " 2>&1"
  end

  -- `&` rather than `&&`: one legendary error in the middle shouldn't silently
  -- drop everything after it.
  local line = table.concat(commands, " & echo " .. SEPARATOR .. " & ")

  -- The whole line is then wrapped in one more pair of quotes. utils.exec goes
  -- through popen, which runs `cmd /c <line>`, and cmd strips the first and last
  -- quote off that line before parsing it. Without the extra pair it eats the
  -- quotes around the binary and splits the path at its first space - and the
  -- path always has one, since Steam installs to Program Files (x86). The error
  -- is "'C:\Program' is not recognized", printed to a console nobody reads.
  local output, status = utils.exec('"' .. line .. '"')
  logger:info("Exited " .. tostring(status) .. ": " .. line)

  -- Split by hand rather than with utils.split, which takes its delimiter a
  -- character at a time and would cut this into pieces at every dash.
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

  return outputs, tonumber(status) or -1
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
  -- stdout and stderr are merged, so the JSON arrives with legendary's own log
  -- lines mixed in. Those look like "[cli] INFO: Logging in..." - so searching
  -- for the first "[" locks onto the "[cli]" of a log line and decodes that.
  -- Scan for the first line that opens a document and isn't a log prefix.
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

---Pick the most useful line out of a failed command's output.
---@param output string
---@param fallback string
---@return string
local function last_error(output, fallback)
  local last
  for line in output:gmatch("[^\r\n]+") do
    if line:find("ERROR:") or line:find("CRITICAL:") then last = utils.trim(line) end
  end
  return last or fallback
end

-- Status ----------------------------------------------------------------------

---@class LegendaryStatus
---@field available boolean Is the binary present
---@field authenticated boolean Is there a logged in Epic account
---@field account string|nil Epic display name, when authenticated
---@field login_url string Where to send the user to sign in
---@field error string|nil Why we couldn't read a status

--- Cached because reading it costs a subprocess launch and a terminal flash, and
--- it's checked on every plugin load and every panel render.
---@type LegendaryStatus|nil
local status = nil

---@param refresh boolean|nil Re-read rather than using the cached answer
---@return LegendaryStatus
function legendary.get_status(refresh)
  if status and not refresh then return status end

  if not fs.is_file(BINARY) then
    status = {
      available = false,
      authenticated = false,
      login_url = LOGIN_URL,
      error = "No legendary binary at " .. BINARY,
    }
    return status
  end

  -- `status --json` is the only command that reports the logged in account, and
  -- it reports "<not logged in>" rather than failing when nobody is.
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

-- `legendary auth --import` would lift an existing login straight out of the
-- Epic Games Launcher, with no browser and nothing to copy. It isn't offered:
-- Epic allows one session per client id, so importing signs the user out of the
-- Epic Games Launcher itself. Silently ending a session in another application
-- is not a reasonable thing for this plugin to do to someone.

---Finish a sign in with the code from Epic's redirect page.
---
---`legendary auth` on its own opens a browser and then *blocks on stdin* waiting
---for that code to be pasted in. There's no stdin here, so it dies with
---"RuntimeError: lost sys.stdin" the moment the browser opens - the login looks
---like it worked and nothing is ever saved. `--code` is the non-interactive
---form: the frontend opens the page, the user copies the code off it, and the
---exchange happens here in one shot.
---
---Success can't be read off the exit code: legendary exits 0 even when a login
---fails, so the only reliable answer is to ask it who it thinks we are after.
---@param code string The authorizationCode from Epic's redirect page
---@return boolean success
---@return string? error
function legendary.authenticate(code)
  if type(code) ~= "string" or utils.trim(code) == "" then return false, "No code provided" end

  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  if legendary.get_status(true).authenticated then return true end

  -- legendary's own error here is almost always "authorization_code_not_found",
  -- i.e. expired or already used, which explains it better than anything we'd
  -- invent.
  --
  -- Note that a failed attempt is not a no-op: legendary clears the stored login
  -- before trying the new code, so getting this wrong signs the user out rather
  -- than leaving them as they were. Hence the wording.
  return false,
    last_error(
      output,
      "That code didn't work - it may have expired or already been used. Press Sign in for a fresh one."
    )
end

---Sign out, so the next sign in starts clean.
---@return boolean success
function legendary.sign_out()
  legendary.run({ "auth", "--delete" })
  return not legendary.get_status(true).authenticated
end

return legendary
