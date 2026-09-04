local fs = require("fs")
local logger = require("logger")
local utils = require("utils")

-- Breadcrumbs for the next crash.
--
-- When the Lua host dies it writes a minidump into `millennium/crashes`, and
-- that dump carries the faulting thread's stack and nothing else: no other
-- thread, no heap to speak of, and Millennium's own logger has no file on disk
-- to read afterwards. So a crash arrives with no record of what the plugin was
-- doing when it happened.
--
-- Every event here is appended to a file, which is what survives the process.
-- The ones that shouldn't be happening at all also go through `logger`, because
-- Millennium's formatted log lines do land in the dump even though its log
-- never reaches disk - a crash report can be read for `EPIC|` and give up the
-- last few things that went wrong.

local trace = {}

local PATH = utils.get_backend_path() .. "/data/trace.log"

--- Trimmed back to half of this when it gets there, so the file stays worth
--- opening and a Steam that runs for a week doesn't grow one without end.
local MAX_BYTES = 256 * 1024

--- Checking the size costs a stat, so it happens every so many writes rather
--- than on each one.
local CHECK_EVERY = 64

local written = 0

--- The directory may not exist yet: the first line written is the one from
--- on_load, which runs before anything else has had a reason to make it.
local opened = false

---`key=value key=value`, ordered so a line reads the same way every time.
---@param fields table<string, any>|nil
---@return string
local function format_fields(fields)
  if not fields then
    return ""
  end

  local keys = {}
  for key in pairs(fields) do
    table.insert(keys, key)
  end
  table.sort(keys)

  local parts = {}
  for _, key in ipairs(keys) do
    local value = fields[key]
    if type(value) == "string" then
      -- Spaces would run two fields together, and the values that carry them
      -- are game names, which are the whole point of the line.
      value = '"' .. value:gsub('"', "'") .. '"'
    end
    table.insert(parts, key .. "=" .. tostring(value))
  end

  return table.concat(parts, " ")
end

---Drop the older half of the file.
local function trim()
  local size = fs.file_size(PATH)
  if not size or size < MAX_BYTES then
    return
  end

  local content = utils.read_file(PATH)
  if not content then
    return
  end

  local lines = utils.split(content, "\n")
  utils.write_file(PATH, utils.join(utils.slice(lines, math.floor(#lines / 2)), "\n"))
end

---Record something that happened. Never throws and never returns a failure:
---a plugin that breaks because its own logging did is worse than one with a
---gap in its log.
---@param event string
---@param fields? table<string, any>
---@return string line What was written, for a caller that wants to log it too
function trace.event(event, fields)
  local line = string.format("%d %s %s", utils.time_ms(), event, format_fields(fields))

  pcall(function()
    if not opened then
      fs.create_directories(fs.parent_path(PATH))
      opened = true
    end

    utils.append_file(PATH, line .. "\n")

    written = written + 1
    if written % CHECK_EVERY == 0 then
      trim()
    end
  end)

  return line
end

---Record something that shouldn't have happened, and put it where a crash dump
---will pick it up as well.
---@param event string
---@param fields? table<string, any>
function trace.anomaly(event, fields)
  logger:error("EPIC|" .. trace.event(event, fields))
end

return trace
