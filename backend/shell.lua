local fs = require("fs")
local utils = require("utils")

-- Running a command and waiting for it.
--
-- `utils.exec` starts cmd with no window, and the programs it runs share cmd's
-- hidden console, so nothing here flashes on screen.
--
-- `shell.run` blocks the Lua state for as long as the command takes, and there
-- is no timeout: a command that never exits takes the Lua state with it. Work
-- too long to wait for belongs in `jobs.lua`.

local shell = {}

---Is `path` a lock file that some process is holding open?
---
---Windows refuses every other open of a file opened unshared, so a write that
---fails is a process still holding it. Costs no process of its own, which
---matters for something asked once a second.
---@param path string
---@return boolean
function shell.is_locked(path)
  if not fs.is_file(path) then
    return false
  end

  -- nil rather than false on failure, so only true counts as getting in.
  return utils.write_file(path, "") ~= true
end

---Escape a string for a single-quoted PowerShell literal.
---@param value string
---@return string
function shell.ps_quote(value)
  return "'" .. value:gsub("'", "''") .. "'"
end

---A one line VBScript that runs a PowerShell script with no window at all and
---doesn't wait for it.
---
---`WScript.Shell.Run` with a window style of 0 starts a console application
---detached and unseen, which `utils.exec` can't: it waits for the command.
---@param script_path string
---@return string
function shell.vbs_launcher(script_path)
  local command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "'
    .. (script_path:gsub("/", "\\"))
    .. '"'
  return 'CreateObject("WScript.Shell").Run "' .. command:gsub('"', '""') .. '", 0, False'
end

---Quote a single argument for cmd.exe.
---@param arg string
---@return string
local function cmd_quote(arg)
  return '"' .. arg:gsub('"', '\\"') .. '"'
end

---Run a program and block until it exits.
---@param exe string
---@param args string[]
---@return string output stdout and stderr
---@return integer code -1 if the command could not be run at all
function shell.run(exe, args)
  local parts = { cmd_quote(exe) }
  for _, arg in ipairs(args) do
    table.insert(parts, cmd_quote(arg))
  end

  -- Wrapped in one more pair of quotes: this runs through `cmd /c`, which strips
  -- the outermost pair before parsing, and without it the path to the executable
  -- loses its quotes and splits at its first space.
  local output, status = utils.exec('"' .. table.concat(parts, " ") .. ' 2>&1"')
  return output or "", tonumber(status) or -1
end

return shell
