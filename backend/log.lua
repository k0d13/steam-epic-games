local DATA = require("data")
local fs = require("fs")
local utils = require("utils")

-- Millennium 3.5 loses the reply to any backend call that writes through its
-- `logger` while the call is running, and the frontend sees nothing but a
-- timeout. So the backend logs to a file of its own instead.

local log = {}

local PATH = DATA .. "/plugin.log"

--- Started over past this, so a Steam that runs for weeks doesn't grow it forever.
local MAX_BYTES = 1024 * 1024

fs.create_directories(DATA)
if (fs.file_size(PATH) or 0) > MAX_BYTES then
  fs.remove(PATH)
end

---@param level string
---@param message string
local function write(level, message)
  utils.append_file(PATH, os.date("%Y-%m-%d %H:%M:%S") .. " " .. level .. " " .. message .. "\n")
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
