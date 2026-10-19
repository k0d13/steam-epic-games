local fs = require("fs")
local legendary = require("legendary")
local library = require("library")
local log = require("log")
local millennium = require("millennium")
local paths = require("paths")

-- These only define ffi functions, so nothing else requires them.
require("details")
require("grid")
require("info")

local function on_load()
  log.info("Backend loading on " .. (paths.IS_WINDOWS and "Windows" or "Linux"))

  -- Left behind by versions that ran commands through a PowerShell daemon.
  -- pcall'd because one still running from before a reload holds its lock file.
  pcall(fs.remove_all, paths.DATA .. "/daemon")

  -- Cache only, so the first GetLibrary is answered from disk.
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
  patches = require("patches"),
}
