local datetime = require("datetime")
local fs = require("fs")
local millennium = require("millennium")
local paths = require("paths")
local shell = require("shell")
local utils = require("utils")

-- `shell.run` would block the Lua state for a whole download, so a job's command
-- runs in a detached PowerShell (a /bin/sh script on Linux) that reports through
-- small files in its directory.

local runner = {}

--- The files in a job directory. The runner scripts refer to them as `{lock}` etc.
local FILES = {
  lock = "runner.lock",
  script = paths.IS_WINDOWS and "runner.ps1" or "runner.sh",
  launcher = "runner.vbs",
  pid = "runner.pid",
  meta = "job.json",
  log = "log.txt",
  status = "status.txt",
  error = "error.txt",
  exit = "exit.txt",
  paused = "paused.txt",
  spawned = "spawned.txt",
}

--- Seconds a job may have neither lock nor PID before its runner counts as lost.
local SPAWN_GRACE = 15

---One of a job directory's files, by its key in `FILES`.
---@param dir string
---@param key string
---@return string
function runner.file(dir, key)
  return dir .. "/" .. FILES[key]
end

---Read one of a job directory's files, or nil if it hasn't been written yet.
---@param dir string
---@param key string
---@return string|nil
function runner.read(dir, key)
  local path = runner.file(dir, key)
  return fs.is_file(path) and utils.read_file(path) or nil
end

--- The runner for this platform, from `backend/scripts`. Braced names are a job
--- directory's files, or the job's own values filled in by `runner.spawn`.
local TEMPLATE = millennium.assets.read("backend/scripts/" .. FILES.script) or ""

---The runner script for one job, its values quoted for the shell that runs it.
---@param dir string
---@param exe string
---@param args string[]
---@return string
local function render(dir, exe, args)
  local quote = paths.IS_WINDOWS and shell.ps_quote or shell.sh_quote
  local quoted = {}
  for index, arg in ipairs(args) do
    quoted[index] = quote(arg)
  end

  local values = {
    dir = quote(dir),
    exe = quote(exe),
    args = table.concat(quoted, paths.IS_WINDOWS and ", " or " "),
  }
  -- A function, so a value's `%` isn't read as a capture and a brace pair that
  -- names nothing stays as written.
  return (TEMPLATE:gsub("{(%w+)}", function(name)
    return values[name] or FILES[name]
  end))
end

---Start a hidden, detached runner. `utils.exec` waits for the command to finish,
---so on Windows it goes through wscript and on Linux it's backgrounded with `&`.
---@param dir string
---@param exe string The program the runner owns
---@param args string[] Arguments to it
---@return boolean started
---@return string? error
function runner.spawn(dir, exe, args)
  if TEMPLATE == "" then
    return false, "The job script is missing from the plugin."
  end

  local script_path = runner.file(dir, "script")
  local ok, err = utils.write_file(script_path, render(dir, exe, args))
  if not ok then
    return false, "Could not write the job script: " .. tostring(err)
  end

  local launcher_path = runner.file(dir, "launcher")
  if paths.IS_WINDOWS then
    ok, err = utils.write_file(launcher_path, shell.vbs_launcher(script_path))
    if not ok then
      return false, "Could not write the job launcher: " .. tostring(err)
    end
  end

  -- Before the launch, or a read in between sees it queued and starts a second runner.
  utils.write_file(runner.file(dir, "spawned"), tostring(datetime.unix()))

  if paths.IS_WINDOWS then
    shell.run("wscript", { shell.native_path(launcher_path) })
  else
    utils.exec("setsid sh " .. shell.sh_quote(script_path) .. " </dev/null >/dev/null 2>&1 &")
  end
  return true
end

---Is the runner still alive? Polled every second, so it tests the lock the runner
---holds unshared rather than spawning `tasklist`.
---@param dir string
---@param pid integer|nil
---@param spawned_at integer|nil
---@return boolean
function runner.is_running(dir, pid, spawned_at)
  -- No unshared locks on Linux, but /proc has a directory per live process.
  if not paths.IS_WINDOWS then
    if pid == nil then
      return (datetime.unix() - (spawned_at or 0)) < SPAWN_GRACE
    end
    return fs.is_directory("/proc/" .. pid)
  end

  local lock = runner.file(dir, "lock")
  if not fs.is_file(lock) then
    -- A PID without the lock means the runner died starting up. Neither means
    -- it's still starting, but only for SPAWN_GRACE.
    return pid == nil and (datetime.unix() - (spawned_at or 0)) < SPAWN_GRACE
  end

  return shell.is_locked(lock)
end

---Kill a runner and legendary under it. `/T` takes the tree down on Windows,
---and `/F` because legendary ignores anything gentler mid-download; on Linux the
---runner leads its own process group, so the negative PID does the same.
---@param pid integer
function runner.kill(pid)
  if paths.IS_WINDOWS then
    shell.run("taskkill", { "/F", "/T", "/PID", tostring(pid) })
  else
    shell.run("kill", { "-KILL", "--", "-" .. pid })
  end
end

---The download progress the runner last wrote, if any.
---@param dir string
---@return JobProgress|nil
function runner.progress(dir)
  local text = runner.read(dir, "status")
  if not text then
    return nil
  end

  local fields = {}
  -- Underscores included: a key pattern of `%w+` reads `updated_at` as `at`.
  for key, value in text:gmatch("([%w_]+)=([^\r\n]*)") do
    fields[key] = value
  end
  if not fields.percent then
    return nil
  end

  return {
    percent = tonumber(fields.percent) or 0,
    downloaded = tonumber(fields.downloaded) or 0,
    total = tonumber(fields.total) or 0,
    eta = fields.eta ~= "" and fields.eta or nil,
    elapsed = fields.elapsed ~= "" and fields.elapsed or nil,
    speed = tonumber(fields.speed),
  }
end

return runner
