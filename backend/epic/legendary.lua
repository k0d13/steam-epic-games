local cache = require("core.cache")
local fs = require("fs")
local log = require("core.log")
local shell = require("core.shell")
local utils = require("utils")
local vendor = require("epic.vendor")

-- A wrapper around the legendary CLI (https://github.com/derrod/legendary), which
-- owns Epic's OAuth entirely, so we never see a password and only read its token

local legendary = {}

---@type string|nil
local binary_path = nil

---Downloaded on first use, and public because shortcuts launch legendary rather than
---the game's exe
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

---App names end up in paths, config sections and command lines
---@param name any
---@return boolean
function legendary.is_app_name(name)
  return type(name) == "string"
    and name:match("^[%w%-_.]+$") ~= nil
    and name:find("..", 1, true) == nil
end

local function subcommand(args)
  for _, arg in ipairs(args) do
    if arg:sub(1, 1) ~= "-" then
      return arg
    end
  end
  return "?"
end

---@param args string[] Unquoted
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

-- legendary's own log lines, like "[cli] INFO: Logging in..."
local function is_log_line(trimmed)
  return trimmed:match("^%[[%w%-%._]+%]%s+%u+:") ~= nil
end

---The last error line in some output, not the Python traceback a crash prints
---@param output string
---@return string|nil
function legendary.last_error(output)
  local last
  for line in output:gmatch("[^\r\n]+") do
    if line:find("ERROR:") or line:find("CRITICAL:") then
      last = utils.trim(line)
    end
  end
  return last
end

---@param output string
---@return any|nil decoded
---@return string? error
function legendary.decode_json(output)
  local lines = utils.split(output, "\n")
  for index, line in ipairs(lines) do
    local trimmed = utils.trim(line)
    local opens = trimmed:sub(1, 1)
    -- Log lines also start with "[", so they're skipped
    if (opens == "{" or opens == "[") and not is_log_line(trimmed) then
      -- Stop at the next log line, as stderr shares the pipe and can follow the document
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

  return nil, legendary.last_error(output) or utils.trim(output):sub(1, 200)
end

return legendary
