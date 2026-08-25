local fs = require("fs")
local json = require("json")
local logger = require("logger")
local shell = require("shell")
local utils = require("utils")

-- Work too long to wait for: installs, updates, uninstalls.
--
-- Running one through `shell.run` would freeze the Lua state, and every RPC
-- with it, for the length of the download. So a job is a detached PowerShell
-- process that owns the command and writes its progress and its last error to
-- small files; this module only reads those files back.
--
-- Nothing here knows what it is running. The progress lines it watches for are
-- legendary's, but the caller supplies the program and the arguments, and
-- `legendary.lua` is what turns "install this game" into either of those.
--
-- legendary refuses to run two of these at once, so only one job ever has a
-- runner. The rest sit in the directory with everything needed to start them
-- and no process, and `jobs.list()` starts the next one as soon as it sees the
-- previous finish. The queue is therefore on disk like the rest of it, and a
-- Steam restart mid-queue loses nothing.
--
-- The frontend polls `jobs.list()` about once a second, so that path stays
-- cheap: it only reads files, and nothing it reads grows with the download.

local jobs = {}

local ROOT = utils.get_backend_path() .. "/data/jobs"

--- Everything a job directory holds, named the way `shell.lua` names the
--- daemon's files: the ones the runner process itself owns carry its name, and
--- the small ones it writes as it goes say what is in them.
---
--- The runner script spells these as `{lock}` and so on rather than repeating
--- them, so this table stays the only place they're written down.
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

--- How long a job is allowed to have neither a lock nor a PID before it counts
--- as a runner that never came up. Only has to cover a wscript launch.
local SPAWN_GRACE = 15

---@alias JobKind "install" | "uninstall"
---@alias JobState "queued" | "running" | "paused" | "done" | "failed"

---@class JobProgress
---@field percent number 0-100
---@field downloaded integer Bytes, as legendary counts them
---@field total integer Bytes
---@field eta string|nil "00:10:00", straight from legendary
---@field elapsed string|nil "00:01:23"
---@field speed number|nil MiB/s, raw off the wire

---@class Job
---@field app_name string
---@field kind JobKind
---@field state JobState
---@field pid integer|nil PID of the runner, which owns legendary as a child
---@field started_at integer When the job was asked for, which is its place in the queue
---@field spawned_at integer|nil When its runner was actually launched, nil while queued
---@field exit_code integer|nil Set once the runner has finished
---@field progress JobProgress|nil
---@field error string|nil Last error line legendary printed, when it failed

-- Job directories -------------------------------------------------------------

---One directory per game. Epic's app names are alphanumeric already, but
---they're not ours to trust as path components.
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

---Read a file, or nil if it isn't there yet. The runner creates these as it
---goes, so missing is normal.
---@param path string
---@return string|nil
local function read(path)
  if not fs.is_file(path) then
    return nil
  end
  return utils.read_file(path)
end

-- The runner ------------------------------------------------------------------

--- The script the detached process runs. legendary goes in a pipeline so this
--- one PID owns everything - `taskkill /T` on it takes legendary down too - and
--- `2>&1` pulls in stderr, where the progress lines go.
---
--- Every line is appended to the log, and the ones carrying progress or an error
--- also overwrite a small file of their own, so reading either back never costs
--- a scan of a log hundreds of kilobytes long.
local RUNNER = [[
$ErrorActionPreference = 'Continue'

# Held, unshared, for as long as this process lives, so the plugin can tell
# whether the runner is still going by trying to open it. Deliberately never
# closed: the handle goes when the process does, which is after the exit code
# at the end of this script has been written.
$Lock = [System.IO.File]::Open("$Dir\{lock}", 'Create', 'Write', 'None')

$PID | Out-File -Encoding ascii -FilePath "$Dir\{pid}"

# One handle held open for the whole download rather than an open, write and
# close per line: legendary prints thousands of them, and it is the only work
# this loop does on every single one.
$Log = New-Object System.IO.StreamWriter "$Dir\{log}", $true, (New-Object System.Text.UTF8Encoding $false)
$Log.AutoFlush = $true

$percent = 0; $done = 0; $total = 0; $eta = ''; $elapsed = ''; $speed = 0

& $Exe @Arguments 2>&1 | ForEach-Object {
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

--- The script as the runner actually runs it.
local RUNNER_SCRIPT = (RUNNER:gsub("{(%w+)}", FILES))

---Start a detached, hidden PowerShell running one legendary command.
---
---Through wscript because it's the only way to get no console window at all:
---`powershell -WindowStyle Hidden` still flashes one, and this window would sit
---on screen for the length of the download.
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
  ok, err = utils.write_file(
    launcher_path,
    shell.vbs_launcher(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "'
        .. (script_path:gsub("/", "\\"))
        .. '"'
    )
  )
  if not ok then
    return false, "Could not write the job launcher: " .. tostring(err)
  end

  -- Before the launch, not after: this is what stops the job reading as queued,
  -- and a read landing in between would otherwise start a second runner.
  utils.write_file(file(dir, "spawned"), tostring(math.floor(utils.time())))

  -- Returns as soon as wscript has handed the runner off, which is the point:
  -- nothing here waits for a download.
  shell.run("wscript", { (launcher_path:gsub("/", "\\")) })
  return true
end

-- Reading a job back ----------------------------------------------------------

---Is the runner that owns this directory still alive?
---
---Asked once a second per job, so it can't cost a subprocess: `tasklist` here
---was a console window flashing up and stealing focus for the length of every
---download. The runner holds `runner.lock` open unshared instead, the same way
---the command daemon holds `daemon.lock`, and nothing else can open it until
---the process has exited.
---@param dir string
---@param pid integer|nil
---@param spawned_at integer|nil
---@return boolean
local function is_running(dir, pid, spawned_at)
  local lock = file(dir, "lock")
  if not fs.is_file(lock) then
    -- The runner takes the lock before it writes its PID, so no lock and a PID
    -- is a job that predates the lock or one whose runner died on the way up.
    -- No lock and no PID is the first moments of a job - but only for a moment:
    -- a wscript that never got the runner up would otherwise leave a job that
    -- reads as running forever, polled once a second with nothing behind it.
    return pid == nil and (utils.time() - (spawned_at or 0)) < SPAWN_GRACE
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
  local text = read(file(dir, "meta"))
  if not text then
    return nil
  end

  local ok, meta = pcall(json.decode, text)
  if not ok or type(meta) ~= "table" then
    return nil
  end
  return meta
end

---Build one job out of its directory and the metadata already read from it.
---
---State is derived rather than stored, since the runner can die without getting
---to record anything: an exit code means finished, a held lock means running,
---and a lock nobody holds with no exit code means the runner died - deliberately
---if pause left its marker behind, otherwise not. A job that was never spawned
---at all is one still waiting its turn.
---@param dir string
---@param meta table
---@return Job
local function build(dir, meta)
  local pid = tonumber(read(file(dir, "pid")) or "")
  local exit_code = tonumber(read(file(dir, "exit")) or "")
  local spawned_at = tonumber(read(file(dir, "spawned")) or "")
  local started_at = meta.started_at or 0

  ---@type JobState
  local state
  if exit_code then
    state = exit_code == 0 and "done" or "failed"
  elseif fs.is_file(file(dir, "paused")) then
    -- Pausing is a kill, so this marker is the only evidence that the missing
    -- process was meant to be missing.
    state = "paused"
  elseif not spawned_at then
    state = "queued"
  else
    state = is_running(dir, pid, spawned_at) and "running" or "failed"
  end

  return {
    app_name = meta.app_name,
    kind = meta.kind or "install",
    state = state,
    pid = pid,
    started_at = started_at,
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
  if not meta then
    return nil
  end

  meta.app_name = meta.app_name or app_name
  return build(dir, meta)
end

---Launch the runner a queued job has been waiting for, if it is that job's turn.
---
---Called off `jobs.list()`, which the frontend polls, so the queue moves on
---roughly a second after the job ahead of it ends. There is no timer behind
---this and nothing in memory holding the order: the oldest `started_at` with no
---runner goes next.
---@param entries { dir: string, meta: table, job: Job }[]
local function promote(entries)
  ---@type { dir: string, meta: table, job: Job }|nil
  local next_up

  for _, entry in ipairs(entries) do
    if entry.job.state == "running" then
      return
    end
    if
      entry.job.state == "queued" and (not next_up or entry.job.started_at < next_up.job.started_at)
    then
      next_up = entry
    end
  end

  if not next_up then
    return
  end

  -- Written by `jobs.start`, which is the only thing that knows what legendary
  -- call the job stands for. Without them there is nothing to run.
  local meta = next_up.meta
  if type(meta.exe) ~= "string" or type(meta.args) ~= "table" then
    logger:warn("Dropping a queued job with nothing to run: " .. tostring(meta.app_name))
    fs.remove_all(next_up.dir)
    return
  end

  local started, err = spawn(next_up.dir, meta.exe, meta.args)
  if not started then
    logger:error("Could not start the queued " .. tostring(meta.kind) .. ": " .. tostring(err))
    return
  end

  logger:info("Started the queued " .. tostring(meta.kind) .. " for " .. tostring(meta.app_name))
  next_up.job = build(next_up.dir, meta)
end

---Every job we know about, queued, running or finished.
---
---Also where the queue moves: reading the jobs is the only thing that happens
---often enough to notice one of them ending.
---@return Job[]
function jobs.list()
  local entries = {}
  if not fs.is_directory(ROOT) then
    return {}
  end

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

-- Starting and stopping -------------------------------------------------------

---Queue one job for a game, replacing whatever it last ran, and start it if
---nothing else is running.
---
---Nothing here spawns: writing the job down is enough, and `promote` picks it
---up on the same call. So a second install while the first is downloading takes
---exactly this path and simply waits.
---@param app_name string
---@param kind JobKind
---@param exe string
---@param args string[]
---@return Job|nil job
---@return string? error
function jobs.start(app_name, kind, exe, args)
  if type(app_name) ~= "string" or app_name == "" then
    return nil, "No app name provided"
  end

  local existing = jobs.get(app_name)
  if existing and (existing.state == "running" or existing.state == "queued") then
    return existing
  end

  -- Everything from a previous run goes, or a fresh install reports the
  -- percentage the old one stopped at until its first progress line.
  local dir = job_dir(app_name)
  if fs.is_directory(dir) then
    fs.remove_all(dir)
  end
  fs.create_directories(dir)

  -- The command goes in with the rest of it, since whatever eventually runs
  -- this job may be a poll minutes from now with no memory of the request.
  local ok, err = utils.write_file(
    file(dir, "meta"),
    json.encode({
      app_name = app_name,
      kind = kind,
      started_at = math.floor(utils.time()),
      exe = exe,
      args = args,
    })
  )
  if not ok then
    return nil, "Could not write the job: " .. tostring(err)
  end

  logger:info("Queued " .. kind .. " for " .. app_name)

  -- Starts it too, if its turn is now.
  jobs.list()
  return jobs.get(app_name)
end

---Kill the runner behind a job we have already read.
---
---legendary has no pause, so stopping is a kill: `/T` takes legendary down with
---the runner, `/F` because it won't respond to anything gentler mid-download.
---@param app_name string
---@param job Job
---@return boolean stopped
local function stop(app_name, job)
  if job.state ~= "running" and job.state ~= "queued" then
    return false
  end

  -- Before the kill: a read landing in the gap would otherwise see a runner
  -- that vanished on its own and call the job failed. For a queued job it is
  -- the whole of the work - the marker is what takes it out of the queue.
  utils.write_file(file(job_dir(app_name), "paused"), "1")

  if job.state == "running" and job.pid then
    shell.run("taskkill", { "/F", "/T", "/PID", tostring(job.pid) })
  end
  return true
end

---Stop a running job, keeping what has already been downloaded. Resuming is
---re-running the install.
---@param app_name string
---@return boolean stopped
function jobs.pause(app_name)
  local job = jobs.get(app_name)
  if not job or not stop(app_name, job) then
    return false
  end

  logger:info("Paused " .. app_name)
  return true
end

---Stop a job and forget it ever ran. What's on disk is left alone - removing a
---partial install is `uninstall`'s job.
---@param app_name string
---@return boolean cancelled
function jobs.cancel(app_name)
  local job = jobs.get(app_name)
  if not job then
    return false
  end

  stop(app_name, job)
  fs.remove_all(job_dir(app_name))
  logger:info("Cancelled " .. app_name)
  return true
end

return jobs
