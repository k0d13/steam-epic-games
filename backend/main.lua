local fs = require("fs")
local legendary = require("legendary")
local library = require("library")
local log = require("log")
local DATA = log.DATA
local millennium = require("millennium")

-- Loaded for its `---@ffi` functions; the other modules are required above.
require("grid")

local function on_load()
  -- Left behind by versions that ran commands through a PowerShell daemon.
  -- pcall'd because one still running from before a reload holds its lock file.
  pcall(fs.remove_all, DATA .. "/daemon")

  -- Cache only, so the first get_library is answered from disk.
  library.load()

  millennium.ready()
  log.info("Backend loaded, waiting for frontend...")
end

local function on_frontend_loaded()
  -- Downloads legendary if missing, so startup pays for it, not the first action.
  local status = legendary.get_status()
  log.info(
    "Frontend loaded. legendary available="
      .. tostring(status.available)
      .. " authenticated="
      .. tostring(status.authenticated)
  )
end

local function on_unload()
  log.info("Backend unloaded")
end

return {
  on_load = on_load,
  on_frontend_loaded = on_frontend_loaded,
  on_unload = on_unload,
}
