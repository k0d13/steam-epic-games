--# selene: allow(unused_variable)
local legendary = require("epic.legendary")
local library = require("steam.library")
local log = require("core.log")
local paths = require("core.paths")
local queue = require("jobs.queue")
local shell = require("core.shell")

-- Runs the zipapp named by the first argument after the start method is set
local FORK_BOOT = "import multiprocessing, runpy, sys; multiprocessing.set_start_method('fork'); "
  .. "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')"

---The Linux build is a zipapp on the system Python, and 3.14 made forkserver the
---default, under which legendary's download workers hang, so fork comes back
---@param binary string
---@param args string[]
---@return string exe
---@return string[] args
local function job_command(binary, args)
  if paths.IS_WINDOWS then
    return binary, args
  end

  local boot = { "-c", FORK_BOOT, binary }
  for _, arg in ipairs(args) do
    table.insert(boot, arg)
  end
  return "python3", boot
end

---@param app_name string
---@param kind JobKind
---@param args string[]
---@param target? string
---@return Job|nil
local function start_job(app_name, kind, args, target)
  if not legendary.is_app_name(app_name) then
    log.warn("Refused a " .. kind .. " for " .. tostring(app_name))
    return nil
  end

  local binary, err = legendary.get_binary()
  local job
  if binary then
    local exe, command_args = job_command(binary, args)
    job, err = queue.start(app_name, kind, exe, command_args, target)
  end

  if not job then
    log.warn("Could not start the " .. kind .. " of " .. app_name .. ": " .. tostring(err))
  end
  return job
end

---@ffi
---Progress comes back through GetJobs, and legendary's install resumes a partial
---download in place
---@param app_name string
---@param base_path? string Parent directory, legendary's default if nil
---@param game_folder? string Directory name inside it
---@param with_dlcs? boolean Whether to install the DLC the account owns, which is the default
---@return Job|nil
function StartInstall(app_name, base_path, game_folder, with_dlcs)
  local args = { "-y", "install", app_name }

  if with_dlcs == false then
    table.insert(args, "--skip-dlcs")
  end

  if type(base_path) == "string" and base_path ~= "" then
    table.insert(args, "--base-path")
    table.insert(args, shell.native_path(base_path))
  end
  if type(game_folder) == "string" and game_folder ~= "" then
    table.insert(args, "--game-folder")
    table.insert(args, game_folder)
  end

  return start_job(app_name, "install", args)
end

---@ffi
---Refuses a game that isn't installed rather than quietly installing it. Not
---`--update-only`, which legendary also applies to each owned DLC and exits on the first
---one that isn't installed
---@param app_name string
---@param with_dlcs? boolean
---@return Job|nil
function StartUpdate(app_name, with_dlcs)
  local game = library.find(app_name)
  if not game or not game.installed then
    log.warn("Refused an update for " .. tostring(app_name))
    return nil
  end

  local args = { "-y", "install", app_name }
  if with_dlcs == false then
    table.insert(args, "--skip-dlcs")
  end
  return start_job(app_name, "update", args)
end

---@ffi
---Fails the job when any file is wrong, as legendary exits 0 either way
---@param app_name string
---@return Job|nil
function StartVerify(app_name)
  return start_job(app_name, "verify", { "-y", "verify", app_name })
end

---@ffi
---Verifies, then downloads what failed. The caller checks the game is installed, as
---legendary would install a game it doesn't have
---@param app_name string
---@return Job|nil
function StartRepair(app_name)
  return start_job(app_name, "repair", { "-y", "install", app_name, "--repair" })
end

---@ffi
---The Steam shortcut is left alone, as keeping uninstalled games in the library is the
---point of the plugin
---@param app_name string
---@return Job|nil
function StartUninstall(app_name)
  return start_job(app_name, "uninstall", { "-y", "uninstall", app_name })
end

---The DLC's job is kept under its game, which is what the frontend looks jobs up by
---@param app_name string
---@param dlc_name string
---@return EpicDlc|nil
local function find_dlc(app_name, dlc_name)
  local game = library.find(app_name)
  if not game or not game.installed or not legendary.is_app_name(dlc_name) then
    return nil
  end

  for _, dlc in ipairs(game.dlcs or {}) do
    if dlc.app_name == dlc_name then
      return dlc
    end
  end
  return nil
end

---@ffi
---Legendary refuses DLC whose game isn't installed
---@param app_name string The game
---@param dlc_name string
---@return Job|nil
function StartDlcInstall(app_name, dlc_name)
  if not find_dlc(app_name, dlc_name) then
    log.warn("Refused DLC " .. tostring(dlc_name) .. " for " .. tostring(app_name))
    return nil
  end
  return start_job(app_name, "dlc", { "-y", "install", dlc_name }, dlc_name)
end

---@ffi
---@param app_name string The game
---@param dlc_name string
---@return Job|nil
function StartDlcUninstall(app_name, dlc_name)
  if not find_dlc(app_name, dlc_name) then
    log.warn("Refused removing DLC " .. tostring(dlc_name) .. " for " .. tostring(app_name))
    return nil
  end
  return start_job(app_name, "dlc", { "-y", "uninstall", dlc_name }, dlc_name)
end
