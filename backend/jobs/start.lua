--# selene: allow(unused_variable)
local legendary = require("epic.legendary")
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
---@return Job|nil
local function start_job(app_name, kind, args)
  local binary, err = legendary.get_binary()
  local job
  if binary then
    local exe, command_args = job_command(binary, args)
    job, err = queue.start(app_name, kind, exe, command_args)
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
---@return Job|nil
function StartInstall(app_name, base_path, game_folder)
  local args = { "-y", "install", app_name }

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
---Refuses a game that isn't installed rather than quietly installing it
---@param app_name string
---@return Job|nil
function StartUpdate(app_name)
  return start_job(app_name, "update", { "-y", "install", app_name, "--update-only" })
end

---@ffi
---The Steam shortcut is left alone, as keeping uninstalled games in the library is the
---point of the plugin
---@param app_name string
---@return Job|nil
function StartUninstall(app_name)
  return start_job(app_name, "uninstall", { "-y", "uninstall", app_name })
end
