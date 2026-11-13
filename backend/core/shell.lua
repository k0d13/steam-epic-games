local datetime = require("datetime")
local fs = require("fs")
local paths = require("core.paths")
local utils = require("utils")

-- shell.run blocks the Lua state with no timeout, and Millennium holds one lock across every
-- plugin's calls while ours waits, so anything that can be slow goes through shell.start

local shell = {}

---Backslashes for the Windows programs that won't take a forward slash, and an
---uppercase drive letter since Millennium hands Steam's path back lowercased
---@param path string
function shell.native_path(path)
  if not paths.IS_WINDOWS then
    return path
  end
  return (path:gsub("/", "\\"):gsub("^%a:", string.upper))
end

---Windows refuses a write to a file opened unshared, which costs no subprocess
---@param path string
---@return boolean
function shell.is_locked(path)
  if not fs.is_file(path) then
    return false
  end

  -- nil rather than false on failure, so only true counts as getting in
  return utils.write_file(path, "") ~= true
end

-- PowerShell also closes a single-quoted string at ‘ ’ ‚ ‛
local PS_QUOTES = { "'", "\226\128\152", "\226\128\153", "\226\128\154", "\226\128\155" }

---For a single-quoted PowerShell literal
---@param value string
function shell.ps_quote(value)
  for _, quote in ipairs(PS_QUOTES) do
    value = value:gsub(quote, quote .. quote)
  end
  return "'" .. value .. "'"
end

---For /bin/sh: close the quote, escape one, reopen
---@param arg string
function shell.sh_quote(arg)
  return "'" .. arg:gsub("'", [['\'']]) .. "'"
end

---cmd.exe has no escape inside quotes, so a " can't be passed through it safely
---@param arg string
local function cmd_quote(arg)
  if arg:find('["\r\n]') then
    return nil
  end
  return '"' .. arg:gsub("(\\+)$", "%1%1") .. '"'
end

---Starts a script hidden and without waiting, which utils.exec can't: Windows goes through
---wscript and Linux backgrounds it under setsid, so the script leads its own process group
---@param script_path string A .ps1 or .cmd on Windows, a /bin/sh script on Linux
---@return boolean started
---@return string? error
function shell.detach(script_path)
  if not paths.IS_WINDOWS then
    utils.exec("setsid sh " .. shell.sh_quote(script_path) .. " </dev/null >/dev/null 2>&1 &")
    return true
  end

  local native = shell.native_path(script_path)
  local command = script_path:match("%.ps1$")
      and 'powershell -NoProfile -ExecutionPolicy Bypass -File "' .. native .. '"'
    -- Doubled, as cmd /c strips one pair and "(x86)" would make it strip the path's own
    or 'cmd /c ""' .. native .. '""'
  local launcher = script_path:gsub("%.%w+$", "") .. ".vbs"
  local vbs = 'CreateObject("WScript.Shell").Run "' .. command:gsub('"', '""') .. '", 0, False'

  local ok, err = utils.write_file(launcher, vbs)
  if not ok then
    return false, "Could not write the launcher: " .. tostring(err)
  end
  shell.run("wscript", { shell.native_path(launcher) })
  return true
end

---Run a program and block until it exits
---@param exe string
---@param args string[]
---@return string output stdout and stderr
---@return integer code -1 if the command could not be run at all
function shell.run(exe, args)
  local quote = paths.IS_WINDOWS and cmd_quote or shell.sh_quote
  local parts = { quote(exe) }
  for _, arg in ipairs(args) do
    local quoted = quote(arg)
    if not quoted then
      return "Refused an argument that can't be quoted: " .. arg, -1
    end
    table.insert(parts, quoted)
  end

  local command = table.concat(parts, " ") .. " 2>&1"
  if paths.IS_WINDOWS then
    -- cmd /c strips the outer quotes, which would split the exe path at a space
    command = '"' .. command .. '"'
  else
    -- Steam's stdin never closes, so a prompt would block the Lua state for good
    command = command .. " </dev/null"
  end
  local output, status = utils.exec(command)
  return output or "", tonumber(status) or -1
end

local BACKGROUND = paths.DATA .. "/background"

-- Past this a batch counts as hung, and its commands as failed
local MAX_SECONDS = 300

---@class Batch
---@field dir string
---@field count integer
---@field started_at integer Unix seconds

---@type table<string, Batch>
local batches = {}

---Left behind by batches running when Steam closed
function shell.clean_up()
  pcall(fs.remove_all, BACKGROUND)
end

---@param exe string
---@param args string[]
---@param out string
---@param exit string
---@return string|nil run
---@return string|nil record
local function batch_lines(exe, args, out, exit)
  if not paths.IS_WINDOWS then
    local parts = { shell.sh_quote(exe) }
    for _, arg in ipairs(args) do
      table.insert(parts, shell.sh_quote(arg))
    end
    local run = table.concat(parts, " ") .. " >" .. shell.sh_quote(out) .. " 2>&1 </dev/null"
    return run, "echo $? >" .. shell.sh_quote(exit)
  end

  -- A batch file expands % even inside quotes
  local parts = { cmd_quote(exe) }
  for _, arg in ipairs(args) do
    local quoted = not arg:find("%", 1, true) and cmd_quote(arg)
    if not quoted then
      return nil
    end
    table.insert(parts, quoted)
  end
  local run = table.concat(parts, " ") .. ' >"' .. shell.native_path(out) .. '" 2>&1 <NUL'
  -- Redirect first, as "0>" after echo would read as a handle
  return run, '>"' .. shell.native_path(exit) .. '" echo %ERRORLEVEL%'
end

---Runs commands one after another in a detached process; shell.collect has their output
---once the last has finished
---@param name string One batch per name at a time
---@param commands { exe: string, args: string[] }[]
---@return boolean started False while one by this name hasn't been collected
---@return string? error
function shell.start(name, commands)
  if batches[name] then
    return false
  end

  local dir = BACKGROUND .. "/" .. name .. "-" .. utils.time_ms()
  fs.create_directories(dir)

  local lines = { paths.IS_WINDOWS and "@echo off" or "#!/bin/sh" }
  for index, command in ipairs(commands) do
    local base = dir .. "/" .. index
    local run, record = batch_lines(command.exe, command.args, base .. ".out", base .. ".exit")
    if not run then
      return false, "Refused a command that can't be quoted: " .. command.exe
    end
    table.insert(lines, run)
    table.insert(lines, record)
  end
  table.insert(
    lines,
    paths.IS_WINDOWS and 'type NUL >"' .. shell.native_path(dir .. "/done") .. '"'
      or ": >" .. shell.sh_quote(dir .. "/done")
  )

  local script = dir .. (paths.IS_WINDOWS and "/batch.cmd" or "/batch.sh")
  local newline = paths.IS_WINDOWS and "\r\n" or "\n"
  local ok, err = utils.write_file(script, table.concat(lines, newline) .. newline)
  if not ok then
    return false, "Could not write the batch: " .. tostring(err)
  end

  local started
  started, err = shell.detach(script)
  if not started then
    return false, err
  end

  batches[name] = { dir = dir, count = #commands, started_at = datetime.unix() }
  return true
end

---@param name string
---@return boolean
function shell.is_running(name)
  return batches[name] ~= nil
end

---Each command's output and exit code, in order, once the batch has finished, which frees
---its name; nil while it runs or if none was started
---@param name string
---@return { output: string, code: integer }[]|nil
function shell.collect(name)
  local batch = batches[name]
  if not batch then
    return nil
  end

  local done = fs.is_file(batch.dir .. "/done")
  if not done and datetime.unix() - batch.started_at < MAX_SECONDS then
    return nil
  end
  batches[name] = nil

  local results = {}
  for index = 1, batch.count do
    local base = batch.dir .. "/" .. index
    local output = fs.is_file(base .. ".out") and utils.read_file(base .. ".out") or ""
    local code = fs.is_file(base .. ".exit")
      and tonumber(utils.trim(utils.read_file(base .. ".exit") or ""))
    results[index] = { output = output or "", code = code or -1 }
  end

  -- A hung command still holds its files on Windows
  pcall(fs.remove_all, batch.dir)
  return results
end

return shell
