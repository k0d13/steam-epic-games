local cache = require("core.cache")
local fs = require("fs")
local log = require("core.log")
local paths = require("core.paths")
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

---legendary's own copy of a game's catalog entry
---@param app_name string
---@return table|nil entry
function legendary.catalog(app_name)
  local entry =
    cache.read(paths.legendary_config() .. "/metadata/" .. app_name .. ".json", "catalog")
  return type(entry) == "table" and type(entry.metadata) == "table" and entry or nil
end

---A catalog entry's sandbox, on the entry for most titles and on the Windows asset for the rest
---@param entry table
---@return string|nil
function legendary.namespace(entry)
  local namespace = type(entry.metadata) == "table" and entry.metadata.namespace
  local asset = type(entry.asset_infos) == "table" and entry.asset_infos.Windows
  if type(namespace) ~= "string" and type(asset) == "table" then
    namespace = asset.namespace
  end
  return type(namespace) == "string" and namespace or nil
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
local function is_log_line(output, position)
  return output:find("^[ \t\r]*%[[%w%-%._]+%]%s+%u+:", position) ~= nil
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
  -- Walked by position, as splitting it into lines copies output that can run to megabytes
  local position = 1
  while position <= #output do
    local line_end = output:find("\n", position, true) or #output + 1

    -- Log lines also start with "[", so they're skipped
    if output:find("^[ \t\r]*[%[{]", position) and not is_log_line(output, position) then
      -- Stop at the next log line, as stderr shares the pipe and can follow the document
      local last = #output
      local next_line = line_end + 1
      while next_line <= #output do
        if is_log_line(output, next_line) then
          last = next_line - 1
          break
        end
        next_line = (output:find("\n", next_line, true) or #output) + 1
      end

      local decoded = cache.decode(output:sub(position, last))
      if decoded ~= nil then
        return decoded
      end
      return nil, "could not decode legendary output"
    end

    position = line_end + 1
  end

  return nil, legendary.last_error(output) or utils.trim(output):sub(1, 200)
end

return legendary
