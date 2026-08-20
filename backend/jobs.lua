local fs = require("fs")
local json = require("json")
local legendary = require("legendary")
local logger = require("logger")
local utils = require("utils")

-- Long-running legendary commands: installs, updates, uninstalls.
--
-- Running one through `utils.exec` would freeze the Lua state, and every RPC
-- with it, for the length of the download. So a job is a detached PowerShell
-- process that owns legendary and writes its progress and its last error to
-- small files; this module only reads those files back.
--
-- The frontend polls `jobs.list()` about once a second, so that path stays
-- cheap: one `tasklist` for liveness, and nothing that grows with the download.

local jobs = {}

local ROOT = utils.get_backend_path() .. "/data/jobs"

---@alias JobKind "install" | "uninstall"
---@alias JobState "running" | "paused" | "done" | "failed"

---@class JobProgress
---@field percent number 0-100
---@field downloaded integer Bytes, as legendary counts them
---@field total integer Bytes
---@field eta string|nil "00:10:00", straight from legendary
---@field elapsed string|nil "00:01:23"
---@field speed number|nil MiB/s, raw off the wire
---@field updated_at integer Unix seconds of the last progress line

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
  if not fs.is_file(path) then return nil end
  return utils.read_file(path)
end

-- The runner ------------------------------------------------------------------

---Escape a string for a single-quoted PowerShell literal.
---@param value string
---@return string
local function ps_quote(value)
  return "'" .. value:gsub("'", "''") .. "'"
end

--- The script the detached process runs. legendary goes in a pipeline so this
--- one PID owns everything - `taskkill /T` on it takes legendary down too - and
--- `2>&1` pulls in stderr, where the progress lines go.
---
--- Every line is appended to the log, and the ones carrying progress or an error
--- also overwrite a small file of their own, so reading either back never costs
--- a scan of a log hundreds of kilobytes long.
local RUNNER = [[
$ErrorActionPreference = 'Continue'
$PID | Out-File -Encoding ascii -FilePath "$Dir\pid.txt"

$percent = 0; $done = 0; $total = 0; $eta = ''; $elapsed = ''; $speed = 0

& $Exe @Arguments 2>&1 | ForEach-Object {
  $line = [string]$_
  Add-Content -Encoding utf8 -Path "$Dir\log.txt" -Value $line

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

  $stamp = [int][double]::Parse((Get-Date -UFormat %s))
  @(
    "percent=$percent", "downloaded=$done", "total=$total",
    "eta=$eta", "elapsed=$elapsed", "speed=$speed", "updated_at=$stamp"
  ) -join "`n" | Out-File -Encoding ascii -FilePath "$Dir\status.txt"
}

$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
$code | Out-File -Encoding ascii -FilePath "$Dir\exit.txt"
]]

---Start a detached, hidden PowerShell running one legendary command.
---
---Through wscript because it's the only way to get no console window at all:
---`powershell -WindowStyle Hidden` still flashes one, and this window would sit
---on screen for the length of the download.
---@param dir string
---@param args string[] Arguments to legendary
---@return boolean started
---@return string? error
local function spawn(dir, args)
  local binary = legendary.get_binary()
  if not binary then return false, "No legendary binary" end

  local quoted = {}
  for index, arg in ipairs(args) do
    quoted[index] = ps_quote(arg)
  end

  local script = "$Dir = "
      .. ps_quote(dir)
      .. "\n$Exe = "
      .. ps_quote(binary)
      -- Not $Args: that's a PowerShell automatic variable and can't be assigned.
      .. "\n$Arguments = @("
      .. table.concat(quoted, ", ")
      .. ")\n"
      .. RUNNER

  local script_path = dir .. "/run.ps1"
  local ok, err = utils.write_file(script_path, script)
  if not ok then return false, "Could not write the job script: " .. tostring(err) end

  -- Window style 0 and no wait: hidden, and returns immediately.
  local launcher = 'CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""'
      .. script_path:gsub("/", "\\")
      .. '""", 0, False'

  local launcher_path = dir .. "/run.vbs"
  ok, err = utils.write_file(launcher_path, launcher)
  if not ok then return false, "Could not write the job launcher: " .. tostring(err) end

  utils.exec('wscript "' .. launcher_path:gsub("/", "\\") .. '"')
  return true
end

-- Reading a job back ----------------------------------------------------------

--- Every live runner PID, read in one go: one `tasklist` per poll rather than
--- one per job per poll.
---@type table<integer, true>|nil
local live_pids = nil

---Every live runner PID, or nil when no usable snapshot could be taken.
---
---`tasklist` failing is not the same answer as "nothing is running": treating
---the two alike reports a live install as dead and freezes the download at
---"Download Paused, 100% Complete" until Steam restarts.
---@return table<integer, true>|nil
local function get_live_pids()
  if live_pids then return live_pids end

  local output = utils.exec('tasklist /FI "IMAGENAME eq powershell.exe" /FO CSV /NH 2>&1')
  if not output then return nil end

  local found = {}
  local any = false
  -- CSV rows look like "powershell.exe","1234","Console","1","52,000 K".
  for pid in output:gmatch('"powershell%.exe","(%d+)"') do
    found[tonumber(pid)] = true
    any = true
  end

  -- This is only ever asked while a job with a PID exists, and that job's own
  -- runner is a powershell.exe, so no rows at all means the answer is wrong.
  if not any then return nil end

  live_pids = found
  return live_pids
end

---Drop the PID snapshot, so the next read is current. Held any longer than one
---answer it would report a finished install as still running.
local function invalidate_pids()
  live_pids = nil
end

---@param dir string
---@return JobProgress|nil
local function read_progress(dir)
  local text = read(dir .. "/status.txt")
  if not text then return nil end

  local fields = {}
  for key, value in text:gmatch("(%w+)=([^\r\n]*)") do
    fields[key] = value
  end
  if not fields.percent then return nil end

  return {
    percent = tonumber(fields.percent) or 0,
    downloaded = tonumber(fields.downloaded) or 0,
    total = tonumber(fields.total) or 0,
    eta = fields.eta ~= "" and fields.eta or nil,
    elapsed = fields.elapsed ~= "" and fields.elapsed or nil,
    speed = tonumber(fields.speed),
    updated_at = tonumber(fields.updated_at) or 0,
  }
end

---@param dir string
---@return table|nil
local function read_meta(dir)
  local text = read(dir .. "/job.json")
  if not text then return nil end

  local ok, meta = pcall(json.decode, text)
  if not ok or type(meta) ~= "table" then return nil end
  return meta
end

---Build one job out of its directory and the metadata already read from it.
---
---State is derived rather than stored, since the runner can die without getting
---to record anything: an exit code means finished, a live PID means running, and
---a PID that is gone with no exit code means the runner died - deliberately if
---pause left its marker behind, otherwise not.
---@param dir string
---@param meta table
---@return Job
local function build(dir, meta)
  local pid = tonumber(read(dir .. "/pid.txt") or "")
  local exit_code = tonumber(read(dir .. "/exit.txt") or "")

  ---@type JobState
  local state
  if exit_code then
    state = exit_code == 0 and "done" or "failed"
  elseif fs.is_file(dir .. "/paused.txt") then
    -- Pausing is a kill, so this marker is the only evidence that the missing
    -- process was meant to be missing.
    state = "paused"
  elseif pid then
    local live = get_live_pids()
    -- With no usable answer about what is running, the last thing known is that
    -- this job started; saying otherwise stops the frontend polling it.
    state = (live == nil or live[pid]) and "running" or "failed"
  else
    -- The runner hasn't written its PID yet, which is the first half second of
    -- a job rather than a problem.
    state = "running"
  end

  return {
    app_name = meta.app_name,
    kind = meta.kind or "install",
    state = state,
    pid = pid,
    started_at = meta.started_at or 0,
    exit_code = exit_code,
    progress = read_progress(dir),
    error = state == "failed" and utils.trim(read(dir .. "/error.txt") or "") or nil,
  }
end

---Read one game's job off disk, or nil if it has never had one.
---@param app_name string
---@return Job|nil
function jobs.get(app_name)
  invalidate_pids()

  local dir = job_dir(app_name)
  local meta = read_meta(dir)
  if not meta then return nil end

  meta.app_name = meta.app_name or app_name
  return build(dir, meta)
end

---Every job we know about, running or finished.
---@return Job[]
function jobs.list()
  invalidate_pids()

  local result = {}
  if not fs.is_directory(ROOT) then return result end

  for _, entry in ipairs(fs.list(ROOT) or {}) do
    -- The directory name is a slug, so the app name comes out of the metadata.
    local meta = entry.is_directory and read_meta(entry.path)
    if meta and meta.app_name then table.insert(result, build(entry.path, meta)) end
  end

  return result
end

-- Starting and stopping -------------------------------------------------------

---@param app_name string
---@param kind JobKind
---@param args string[]
---@return Job|nil job
---@return string? error
local function start(app_name, kind, args)
  if type(app_name) ~= "string" or app_name == "" then return nil, "No app name provided" end

  local existing = jobs.get(app_name)
  if existing and existing.state == "running" then return existing end

  -- Everything from a previous run goes, or a fresh install reports the
  -- percentage the old one stopped at until its first progress line.
  local dir = job_dir(app_name)
  if fs.is_directory(dir) then fs.remove_all(dir) end
  fs.create_directories(dir)

  local ok, err = utils.write_file(
    dir .. "/job.json",
    json.encode({ app_name = app_name, kind = kind, started_at = math.floor(utils.time()) })
  )
  if not ok then return nil, "Could not write the job: " .. tostring(err) end

  local started, spawn_error = spawn(dir, args)
  if not started then return nil, spawn_error end

  logger:info("Started " .. kind .. " for " .. app_name)
  return jobs.get(app_name)
end

---Install or update a game.
---
---legendary's `install` is also its update and its resume: pointed at a partial
---download, it continues from there.
---@param app_name string
---@param base_path string|nil Parent directory to install into, legendary's default if nil
---@param game_folder string|nil Directory name inside it
---@return Job|nil job
---@return string? error
function jobs.install(app_name, base_path, game_folder)
  local args = { "-y", "install", app_name }

  if type(base_path) == "string" and base_path ~= "" then
    table.insert(args, "--base-path")
    table.insert(args, (base_path:gsub("/", "\\")))
  end
  if type(game_folder) == "string" and game_folder ~= "" then
    table.insert(args, "--game-folder")
    table.insert(args, game_folder)
  end

  return start(app_name, "install", args)
end

---@param app_name string
---@return Job|nil job
---@return string? error
function jobs.uninstall(app_name)
  return start(app_name, "uninstall", { "-y", "uninstall", app_name })
end

---Stop a running job, keeping what has already been downloaded.
---
---legendary has no pause, so this is a kill: `/T` takes legendary down with the
---runner, `/F` because it won't respond to anything gentler mid-download.
---Resuming is re-running the install.
---@param app_name string
---@return boolean stopped
function jobs.pause(app_name)
  local job = jobs.get(app_name)
  if not job or not job.pid or job.state ~= "running" then return false end

  -- Before the kill: a read landing in the gap would otherwise see a runner
  -- that vanished on its own and call the job failed.
  utils.write_file(job_dir(app_name) .. "/paused.txt", "1")
  utils.exec("taskkill /F /T /PID " .. job.pid .. " 2>&1")
  logger:info("Paused " .. app_name)
  return true
end

---Stop a job and forget it ever ran. What's on disk is left alone - removing a
---partial install is `uninstall`'s job.
---@param app_name string
---@return boolean cancelled
function jobs.cancel(app_name)
  local job = jobs.get(app_name)
  if not job then return false end

  jobs.pause(app_name)
  fs.remove_all(job_dir(app_name))
  logger:info("Cancelled " .. app_name)
  return true
end

return jobs
