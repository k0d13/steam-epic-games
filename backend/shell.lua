local fs = require("fs")
local paths = require("paths")
local utils = require("utils")

-- `shell.run` blocks the Lua state with no timeout; long work belongs in `jobs.lua`.

local shell = {}

---Backslashes for the Windows programs that won't take a forward slash, and an
---uppercase drive letter since Millennium hands Steam's path back lowercased.
---Unchanged on Linux, where a backslash is a legal filename character.
---@param path string
---@return string
function shell.native_path(path)
  if not paths.IS_WINDOWS then
    return path
  end
  return (path:gsub("/", "\\"):gsub("^%a:", string.upper))
end

---Is a process holding `path` open? Windows refuses a write to a file opened
---unshared, and this costs no subprocess.
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

---A one-line VBScript that starts a PowerShell script hidden and doesn't wait,
---which `utils.exec` can't.
---@param script_path string
---@return string
function shell.vbs_launcher(script_path)
  local command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "'
    .. shell.native_path(script_path)
    .. '"'
  return 'CreateObject("WScript.Shell").Run "' .. command:gsub('"', '""') .. '", 0, False'
end

---Quote a single argument for cmd.exe.
---@param arg string
---@return string
local function cmd_quote(arg)
  return '"' .. arg:gsub('"', '\\"') .. '"'
end

---Quote a single argument for /bin/sh: close the quote, escape one, reopen.
---@param arg string
---@return string
function shell.sh_quote(arg)
  return "'" .. arg:gsub("'", [['\'']]) .. "'"
end

---Run a program and block until it exits.
---@param exe string
---@param args string[]
---@return string output stdout and stderr
---@return integer code -1 if the command could not be run at all
function shell.run(exe, args)
  local quote = paths.IS_WINDOWS and cmd_quote or shell.sh_quote
  local parts = { quote(exe) }
  for _, arg in ipairs(args) do
    table.insert(parts, quote(arg))
  end

  local command = table.concat(parts, " ") .. " 2>&1"
  if paths.IS_WINDOWS then
    -- `cmd /c` strips the outer quotes, which would split the exe path at a space.
    command = '"' .. command .. '"'
  else
    -- Steam's stdin never closes, so a prompt would block the Lua state for good.
    command = command .. " </dev/null"
  end
  local output, status = utils.exec(command)
  return output or "", tonumber(status) or -1
end

return shell
