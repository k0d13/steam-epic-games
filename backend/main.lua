local DATA = require("data")
local fs = require("fs")
local legendary = require("legendary")
local library = require("library")
local log = require("log")
local millennium = require("millennium")

-- Loaded for the `---@ffi` functions they define, which is all the frontend
-- calls. legendary, library and jobs are already pulled in above.
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
  log.info("Frontend loaded, checking legendary status...")
  -- Where the one-off download happens, so a machine missing legendary pays for
  -- it at startup rather than in the middle of the first thing it's asked to do.
  local status = legendary.get_status()
  log.info(
    string.format(
      "Frontend loaded. legendary available=%s authenticated=%s",
      tostring(status.available),
      tostring(status.authenticated)
    )
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
