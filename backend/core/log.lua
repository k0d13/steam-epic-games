local datetime = require("datetime")
local fs = require("fs")
local paths = require("core.paths")
local utils = require("utils")

-- Millennium 3.5 drops the reply to any call that writes through its logger, so the
-- backend logs to its own file

local log = {}

local PATH = paths.DATA .. "/plugin.log"
local MAX_LINES = 500

fs.create_directories(paths.DATA)

-- Held in memory so dropping the oldest line doesn't mean reading the file back
local lines = {}
for line in (utils.read_file(PATH) or ""):gmatch("[^\n]+") do
  table.insert(lines, line)
end
local function trim()
  local kept = {}
  for index = #lines - MAX_LINES + 1, #lines do
    table.insert(kept, lines[index])
  end
  lines = kept
  utils.write_file(PATH, table.concat(lines, "\n") .. "\n")
end

-- Also trimmed at load, or quiet sessions would keep appending to an oversized file
if #lines > MAX_LINES then
  trim()
end

local function write(level, message)
  local line = datetime.format(datetime.now()) .. " " .. level .. " " .. message
  table.insert(lines, line)

  -- Trimmed in batches, since a trim rewrites the whole file
  if #lines > MAX_LINES * 2 then
    trim()
  else
    utils.append_file(PATH, line .. "\n")
  end
end

---@param message string
function log.info(message)
  write("INFO", message)
end

---@param message string
function log.warn(message)
  write("WARN", message)
end

---@param message string
function log.error(message)
  write("ERROR", message)
end

return log
