local fs = require("fs")
local paths = require("core.paths")
local utils = require("utils")

-- shell.run blocks the Lua state with no timeout, so long work belongs in jobs/

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

---A VBScript that starts a PowerShell script hidden without waiting, which
---utils.exec can't
---@param script_path string
function shell.vbs_launcher(script_path)
  local command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "'
    .. shell.native_path(script_path)
    .. '"'
  return 'CreateObject("WScript.Shell").Run "' .. command:gsub('"', '""') .. '", 0, False'
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

return shell
