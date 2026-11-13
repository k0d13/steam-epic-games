local account = require("epic.account")
local fs = require("fs")
local library = require("steam.library")
local log = require("core.log")
local millennium = require("millennium")
local paths = require("core.paths")
local shell = require("core.shell")

-- These only define ffi functions, so nothing else requires them
require("jobs.start")
require("steam.achievements")
require("steam.cloud")
require("steam.friends")
require("steam.info")
require("steam.playtime")
require("steam.shortcuts")
require("steam.sizes")

local function on_load()
  log.info("Backend loading on " .. (paths.IS_WINDOWS and "Windows" or "Linux"))

  -- Left behind by versions that ran commands through a PowerShell daemon, and pcall'd
  -- because one still running from before a reload holds its lock file
  pcall(fs.remove_all, paths.DATA .. "/daemon")
  shell.clean_up()

  -- Cache only, so the first GetLibrary is answered from disk
  library.load()

  millennium.ready()
  log.info("Backend loaded, waiting for frontend...")
end

local function on_frontend_loaded()
  -- Starts the download of legendary if it's missing, and reading the account, without waiting
  -- on either, as Millennium holds every plugin's calls while one of ours is busy
  account.status()
  log.info("Frontend loaded")
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
