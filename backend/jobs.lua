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
-- The frontend polls `jobs.list()` about once a second, so that path stays
-- cheap: it only reads files, and nothing it reads grows with the download.

local jobs = {}

local ROOT = utils.get_backend_path() .. "/data/jobs"

--- How long a job is allowed to have neither a lock nor a PID before it counts
--- as a runner that never came up. Only has to cover a wscript launch.
local SPAWN_GRACE = 15

---@alias JobKind "install" | "uninstall"
---@alias JobState "running" | "paused" | "done" | "failed"

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
---@field started_at integer
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
$Lock = [System.IO.File]::Open("$Dir\lock", 'Create', 'Write', 'None')

$PID | Out-File -Encoding ascii -FilePath "$Dir\pid.txt"

# One handle held open for the whole download rather than an open, write and
# close per line: legendary prints thousands of them, and it is the only work
# this loop does on every single one.
$Log = New-Object System.IO.StreamWriter "$Dir\log.txt", $true, (New-Object System.Text.UTF8Encoding $false)
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
      $line | Out-File -Encoding utf8 -FilePath "$Dir\error.txt"
    }
    return
  }

  @(
    "percent=$percent", "downloaded=$done", "total=$total",
    "eta=$eta", "elapsed=$elapsed", "speed=$speed"
  ) -join "`n" | Out-File -Encoding ascii -FilePath "$Dir\status.txt"
}

$code = $LASTEXITCODE
$Log.Dispose()
if ($null -eq $code) { $code = 0 }
$code | Out-File -Encoding ascii -FilePath "$Dir\exit.txt"
]]

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
    .. RUNNER

  local script_path = dir .. "/run.ps1"
  local ok, err = utils.write_file(script_path, script)
  if not ok then
    return false, "Could not write the job script: " .. tostring(err)
  end

  local launcher_path = dir .. "/run.vbs"
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
---download. The runner holds `lock` open unshared instead, which nothing else
---can open until it has exited.
---@param dir string
---@param pid integer|nil
---@param started_at integer|nil
---@return boolean
local function is_running(dir, pid, started_at)
  local lock = dir .. "/lock"
  if not fs.is_file(lock) then
    -- The runner takes the lock before it writes its PID, so no lock and a PID
    -- is a job that predates the lock or one whose runner died on the way up.
    -- No lock and no PID is the first moments of a job - but only for a moment:
    -- a wscript that never got the runner up would otherwise leave a job that
    -- reads as running forever, polled once a second with nothing behind it.
    return pid == nil and (utils.time() - (started_at or 0)) < SPAWN_GRACE
  end

  return shell.is_locked(lock)
end

---@param dir string
---@return JobProgress|nil
local function read_progress(dir)
  local text = read(dir .. "/status.txt")
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
  local text = read(dir .. "/job.json")
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
---if pause left its marker behind, otherwise not.
---@param dir string
---@param meta table
---@return Job
local function build(dir, meta)
  local pid = tonumber(read(dir .. "/pid.txt") or "")
  local exit_code = tonumber(read(dir .. "/exit.txt") or "")
  local started_at = meta.started_at or 0

  ---@type JobState
  local state
  if exit_code then
    state = exit_code == 0 and "done" or "failed"
  elseif fs.is_file(dir .. "/paused.txt") then
    -- Pausing is a kill, so this marker is the only evidence that the missing
    -- process was meant to be missing.
    state = "paused"
  else
    state = is_running(dir, pid, started_at) and "running" or "failed"
  end

  return {
    app_name = meta.app_name,
    kind = meta.kind or "install",
    state = state,
    pid = pid,
    started_at = started_at,
    exit_code = exit_code,
    progress = read_progress(dir),
    error = state == "failed" and utils.trim(read(dir .. "/error.txt") or "") or nil,
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

---Every job we know about, running or finished.
---@return Job[]
function jobs.list()
  local result = {}
  if not fs.is_directory(ROOT) then
    return result
  end

  for _, entry in ipairs(fs.list(ROOT) or {}) do
    -- The directory name is a slug, so the app name comes out of the metadata.
    local meta = entry.is_directory and read_meta(entry.path)
    if meta and meta.app_name then
      table.insert(result, build(entry.path, meta))
    end
  end

  return result
end

-- Starting and stopping -------------------------------------------------------

---Start one job for a game, replacing whatever it last ran.
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
  if existing and existing.state == "running" then
    return existing
  end

  -- Everything from a previous run goes, or a fresh install reports the
  -- percentage the old one stopped at until its first progress line.
  local dir = job_dir(app_name)
  if fs.is_directory(dir) then
    fs.remove_all(dir)
  end
  fs.create_directories(dir)

  local ok, err = utils.write_file(
    dir .. "/job.json",
    json.encode({ app_name = app_name, kind = kind, started_at = math.floor(utils.time()) })
  )
  if not ok then
    return nil, "Could not write the job: " .. tostring(err)
  end

  local started, spawn_error = spawn(dir, exe, args)
  if not started then
    return nil, spawn_error
  end

  logger:info("Started " .. kind .. " for " .. app_name)
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
  if not job.pid or job.state ~= "running" then
    return false
  end

  -- Before the kill: a read landing in the gap would otherwise see a runner
  -- that vanished on its own and call the job failed.
  utils.write_file(job_dir(app_name) .. "/paused.txt", "1")
  shell.run("taskkill", { "/F", "/T", "/PID", tostring(job.pid) })
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
