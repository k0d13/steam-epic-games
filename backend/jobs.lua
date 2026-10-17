--# selene: allow(unused_variable)
local cache = require("cache")
local datetime = require("datetime")
local fs = require("fs")
local json = require("json")
local log = require("log")
local paths = require("paths")
local shell = require("shell")
local utils = require("utils")

-- `shell.run` would block the Lua state for a whole download, so installs, updates
-- and uninstalls run in a detached PowerShell that reports through small files.

local jobs = {}

local ROOT = paths.DATA .. "/jobs"

--- The files in a job directory. The runner script refers to them as `{lock}` etc.
local FILES = {
  lock = "runner.lock",
  script = "runner.ps1",
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

---@alias JobKind "install" | "update" | "uninstall"
---@alias JobState "queued" | "running" | "paused" | "done" | "failed"

---@class JobProgress
---@field percent number 0-100
---@field downloaded integer Chunks, not bytes: that's what legendary counts
---@field total integer Chunks
---@field eta string|nil "00:10:00", straight from legendary
---@field elapsed string|nil "00:01:23"
---@field speed number|nil MiB/s, raw off the wire

---@class Job
---@field app_name string
---@field kind string One of JobKind; starlight types aliases and literals as `unknown`
---@field state string One of JobState
---@field pid integer|nil PID of the runner, which owns legendary as a child
---@field started_at integer When the job was asked for, which is its place in the queue
---@field spawned_at integer|nil When its runner was actually launched, nil while queued
---@field exit_code integer|nil Set once the runner has finished
---@field progress JobProgress|nil
---@field error string|nil Last error line legendary printed, when it failed

---One directory per game, with the app name sanitised rather than trusted.
---@param app_name string
---@return string
local function job_dir(app_name)
  return ROOT .. "/" .. (app_name:gsub("[^%w%-%_]", "_"))
end

---One of a job directory's files, by its key in `FILES`.
---@param dir string
---@param key string
---@return string
local function file(dir, key)
  return dir .. "/" .. FILES[key]
end

---Read a file, or nil if the runner hasn't written it yet.
---@param path string
---@return string|nil
local function read(path)
  if not fs.is_file(path) then
    return nil
  end
  return utils.read_file(path)
end

--- legendary runs in a pipeline so `taskkill /T` on this PID takes it down too.
--- Progress and errors get files of their own so reads never scan the log.
local RUNNER = [[
$ErrorActionPreference = 'Continue'

# Held unshared and never closed, so the plugin can tell the runner is alive by
# failing to open it. It's released only after the exit code below is written.
$Lock = [System.IO.File]::Open("$Dir\{lock}", 'Create', 'Write', 'None')

$PID | Out-File -Encoding ascii -FilePath "$Dir\{pid}"

# One handle for the whole download: legendary prints thousands of lines.
$Log = New-Object System.IO.StreamWriter "$Dir\{log}", $true, (New-Object System.Text.UTF8Encoding $false)
$Log.AutoFlush = $true

$percent = 0; $done = 0; $total = 0; $eta = ''; $elapsed = ''; $speed = 0

# A blank line takes the default at a prompt -y doesn't cover, like the selective
# download one Fortnite gets. Stdin closes after it, so another prompt fails the
# job instead of hanging it.
@('') | & $Exe @Arguments 2>&1 | ForEach-Object {
  $line = [string]$_
  $Log.WriteLine($line)

  if ($line -match 'Progress: ([\d.]+)% \((\d+)/(\d+)\), Running for ([\d:]+), ETA: ([\d:]+)') {
    $percent = $matches[1]; $done = $matches[2]; $total = $matches[3]
    $elapsed = $matches[4]; $eta = $matches[5]
  } elseif ($line -match 'Download\s+- ([\d.]+) MiB/s \(raw\)') {
    $speed = $matches[1]
  } else {
    if ($line -match '(ERROR|CRITICAL):') {
      $line | Out-File -Encoding utf8 -FilePath "$Dir\{error}"
    }
    return
  }

  @(
    "percent=$percent", "downloaded=$done", "total=$total",
    "eta=$eta", "elapsed=$elapsed", "speed=$speed"
  ) -join "`n" | Out-File -Encoding ascii -FilePath "$Dir\{status}"
}

$code = $LASTEXITCODE
$Log.Dispose()
if ($null -eq $code) { $code = 0 }
$code | Out-File -Encoding ascii -FilePath "$Dir\{exit}"
]]

local RUNNER_SCRIPT = (RUNNER:gsub("{(%w+)}", FILES))

---Start a hidden, detached runner. Through wscript because `utils.exec` waits
---for the command to finish.
---@param dir string
---@param exe string The program the runner owns
---@param args string[] Arguments to it
---@return boolean started
---@return string? error
local function spawn(dir, exe, args)
  local quoted = {}
  for index, arg in ipairs(args) do
    quoted[index] = shell.ps_quote(arg)
  end

  local script = "$Dir = "
    .. shell.ps_quote(dir)
    .. "\n$Exe = "
    .. shell.ps_quote(exe)
    -- Not $Args: that's a PowerShell automatic variable and can't be assigned.
    .. "\n$Arguments = @("
    .. table.concat(quoted, ", ")
    .. ")\n"
    .. RUNNER_SCRIPT

  local script_path = file(dir, "script")
  local ok, err = utils.write_file(script_path, script)
  if not ok then
    return false, "Could not write the job script: " .. tostring(err)
  end

  local launcher_path = file(dir, "launcher")
  ok, err = utils.write_file(launcher_path, shell.vbs_launcher(script_path))
  if not ok then
    return false, "Could not write the job launcher: " .. tostring(err)
  end

  -- Before the launch, or a read in between sees it queued and starts a second runner.
  utils.write_file(file(dir, "spawned"), tostring(datetime.unix()))

  shell.run("wscript", { shell.windows_path(launcher_path) })
  return true
end

---Is the runner still alive? Polled every second, so it tests the lock the runner
---holds unshared rather than spawning `tasklist`.
---@param dir string
---@param pid integer|nil
---@param spawned_at integer|nil
---@return boolean
local function is_running(dir, pid, spawned_at)
  local lock = file(dir, "lock")
  if not fs.is_file(lock) then
    -- A PID without the lock means the runner died starting up. Neither means
    -- it's still starting, but only for SPAWN_GRACE.
    return pid == nil and (datetime.unix() - (spawned_at or 0)) < SPAWN_GRACE
  end

  return shell.is_locked(lock)
end

---@param dir string
---@return JobProgress|nil
local function read_progress(dir)
  local text = read(file(dir, "status"))
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

---@param dir string
---@return table|nil
local function read_meta(dir)
  local meta = cache.decode(read(file(dir, "meta")))
  return type(meta) == "table" and meta or nil
end

---Build a job from its directory. State is derived, not stored, since the runner
---can die without recording anything.
---@param dir string
---@param meta table
---@return Job
local function build(dir, meta)
  local pid = tonumber(read(file(dir, "pid")) or "")
  local exit_code = tonumber(read(file(dir, "exit")) or "")
  local spawned_at = tonumber(read(file(dir, "spawned")) or "")

  ---@type JobState
  local state
  if exit_code then
    state = exit_code == 0 and "done" or "failed"
  elseif fs.is_file(file(dir, "paused")) then
    -- Pausing is a kill; this marker says the process was meant to be gone.
    state = "paused"
  elseif not spawned_at then
    state = "queued"
  else
    state = is_running(dir, pid, spawned_at) and "running" or "failed"
  end

  return {
    app_name = meta.app_name,
    kind = meta.kind,
    state = state,
    pid = pid,
    started_at = meta.started_at,
    spawned_at = spawned_at,
    exit_code = exit_code,
    progress = read_progress(dir),
    error = state == "failed" and utils.trim(read(file(dir, "error")) or "") or nil,
  }
end

---Read one game's job off disk, or nil if it has never had one.
---@param app_name string
---@return Job|nil
function jobs.get(app_name)
  local dir = job_dir(app_name)
  local meta = read_meta(dir)
  return meta and build(dir, meta)
end

---Start the oldest queued job if nothing is running. legendary runs one job at a
---time, so the queue lives on disk and moves whenever `jobs.list()` is polled.
---@param entries { dir: string, meta: table, job: Job }[]
local function promote(entries)
  ---@type { dir: string, meta: table, job: Job }|nil
  local next_up

  for _, entry in ipairs(entries) do
    if entry.job.state == "running" then
      return
    end
    if
      entry.job.state == "queued"
      and (not next_up or entry.job.started_at < next_up.job.started_at)
    then
      next_up = entry
    end
  end

  if not next_up then
    return
  end

  -- Written by `jobs.start`; without them there's nothing to run.
  local meta = next_up.meta
  if type(meta.exe) ~= "string" or type(meta.args) ~= "table" then
    log.warn("Dropping a queued job with nothing to run: " .. tostring(meta.app_name))
    fs.remove_all(next_up.dir)
    return
  end

  local started, err = spawn(next_up.dir, meta.exe, meta.args)
  if not started then
    log.error("Could not start the queued " .. tostring(meta.kind) .. ": " .. tostring(err))
    return
  end

  log.info("Started the queued " .. tostring(meta.kind) .. " for " .. tostring(meta.app_name))
  next_up.job = build(next_up.dir, meta)
end

---Every job, queued, running or finished. Also moves the queue along.
---@return Job[]
function jobs.list()
  if not fs.is_directory(ROOT) then
    return {}
  end

  local entries = {}
  for _, entry in ipairs(fs.list(ROOT) or {}) do
    -- The directory name is a slug, so the app name comes out of the metadata.
    local meta = entry.is_directory and read_meta(entry.path)
    if meta and meta.app_name then
      table.insert(entries, { dir = entry.path, meta = meta, job = build(entry.path, meta) })
    end
  end

  promote(entries)

  local result = {}
  for _, entry in ipairs(entries) do
    table.insert(result, entry.job)
  end
  return result
end

---Queue a job for a game, replacing its last one. `promote` starts it in the same
---call if nothing else is running.
---@param app_name string
---@param kind JobKind
---@param exe string
---@param args string[]
---@return Job|nil job
---@return string? error
function jobs.start(app_name, kind, exe, args)
  local existing = jobs.get(app_name)
  if existing and (existing.state == "running" or existing.state == "queued") then
    return existing
  end

  -- Clear the old run, or the new one shows its last percentage until progress arrives.
  local dir = job_dir(app_name)
  if fs.is_directory(dir) then
    fs.remove_all(dir)
  end
  fs.create_directories(dir)

  -- Store the command: whatever starts this job may be a poll minutes from now.
  local ok, err = utils.write_file(
    file(dir, "meta"),
    json.encode({
      app_name = app_name,
      kind = kind,
      started_at = datetime.unix(),
      exe = exe,
      args = args,
    })
  )
  if not ok then
    return nil, "Could not write the job: " .. tostring(err)
  end

  log.info("Queued " .. kind .. " for " .. app_name)

  -- Starts it too, if its turn is now.
  jobs.list()
  return jobs.get(app_name)
end

---Kill a job's runner. `/T` takes legendary down with it, and `/F` because it
---ignores anything gentler mid-download.
---@param job Job
---@return boolean stopped
local function stop(job)
  if job.state ~= "running" and job.state ~= "queued" then
    return false
  end

  -- Before the kill, or a read in between calls the job failed. For a queued job
  -- the marker alone takes it out of the queue.
  utils.write_file(file(job_dir(job.app_name), "paused"), "1")

  if job.state == "running" and job.pid then
    shell.run("taskkill", { "/F", "/T", "/PID", tostring(job.pid) })
  end
  return true
end

---@ffi
---Every job, queued, running or finished. Polled while something downloads.
---@return Job[]
function GetJobs()
  return jobs.list()
end

---@ffi
---Stop a running job, keeping what has already been downloaded. Resuming is
---re-running the install.
---@param app_name string
---@return boolean stopped
function PauseJob(app_name)
  local job = jobs.get(app_name)
  if not job or not stop(job) then
    return false
  end

  log.info("Paused " .. app_name)
  return true
end

---@ffi
---Stop a job and forget it ever ran. What's on disk is left alone - removing a
---partial install is `uninstall`'s job.
---@param app_name string
---@return boolean cancelled
function CancelJob(app_name)
  local job = jobs.get(app_name)
  if not job then
    return false
  end

  stop(job)
  fs.remove_all(job_dir(app_name))
  log.info("Cancelled " .. app_name)
  return true
end

return jobs
