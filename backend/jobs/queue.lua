--# selene: allow(unused_variable)
local cache = require("core.cache")
local datetime = require("datetime")
local fs = require("fs")
local json = require("json")
local log = require("core.log")
local paths = require("core.paths")
local runner = require("jobs.runner")
local utils = require("utils")

-- Installs, updates, repairs, verifies, uninstalls and DLC changes, one at a time since legendary
-- allows one. Each job is a directory runner.lua's process reports into, and the queue is
-- those directories, moved along whenever the frontend polls

local queue = {}

local ROOT = paths.DATA .. "/jobs"

---@alias JobKind "install" | "update" | "repair" | "verify" | "uninstall" | "dlc"
---@alias JobState "queued" | "running" | "paused" | "done" | "failed"

---@class JobProgress
---@field percent number 0-100
---@field downloaded integer Chunks, not bytes
---@field total integer Chunks
---@field eta string|nil "00:10:00", straight from legendary
---@field elapsed string|nil
---@field speed number|nil MiB/s, raw off the wire

---@class Job
---@field app_name string
---@field kind string One of JobKind, as starlight types aliases and literals as unknown
---@field state string One of JobState
---@field pid integer|nil The runner, which owns legendary as a child
---@field started_at integer When it was asked for, which is its place in the queue
---@field spawned_at integer|nil When its runner was launched, nil while queued
---@field exit_code integer|nil Set once the runner has finished
---@field progress JobProgress|nil
---@field error string|nil Last error line legendary printed, when it failed
---@field target string|nil The DLC a dlc job installs or removes

---@class JobEntry
---@field dir string
---@field meta table
---@field job Job

-- The app name is sanitised rather than trusted
local function job_dir(app_name)
  return ROOT .. "/" .. (app_name:gsub("[^%w%-%_]", "_"))
end

local function read_meta(dir)
  local meta = cache.decode(runner.read(dir, "meta"))
  return type(meta) == "table" and meta or nil
end

---State is derived, not stored, since the runner can die without recording anything
---@param dir string
---@param meta table
---@return Job
local function build(dir, meta)
  local pid = tonumber(runner.read(dir, "pid") or "")
  local exit_code = tonumber(runner.read(dir, "exit") or "")
  local spawned_at = tonumber(runner.read(dir, "spawned") or "")

  ---@type JobState
  local state
  if exit_code then
    -- legendary exits 0 after some fatal errors, like another instance holding its
    -- install lock, so a CRITICAL line fails the job too
    local errors = runner.read(dir, "error") or ""
    local fatal = errors:find("CRITICAL:", 1, true) ~= nil
    -- A verify that found bad files exits 0 too, and says so in its last ERROR line
    local bad_files = meta.kind == "verify" and errors ~= ""
    state = (exit_code == 0 and not fatal and not bad_files) and "done" or "failed"
  elseif fs.is_file(runner.file(dir, "paused")) then
    -- Pausing is a kill, and this marker says the process was meant to be gone
    state = "paused"
  elseif not spawned_at then
    state = "queued"
  elseif runner.is_running(dir, pid, spawned_at) then
    state = "running"
  else
    state = "failed"
    -- legendary can outlive its runner, as across a Steam restart, and would hold the
    -- install lock against every retry; the exit code stops this repeating next poll
    if pid then
      runner.reap(pid)
    end
    exit_code = -1
    utils.write_file(runner.file(dir, "exit"), "-1")
    if not runner.read(dir, "error") then
      utils.write_file(runner.file(dir, "error"), "The download stopped unexpectedly.")
    end
  end

  return {
    app_name = meta.app_name,
    kind = meta.kind,
    state = state,
    pid = pid,
    started_at = meta.started_at,
    spawned_at = spawned_at,
    exit_code = exit_code,
    progress = runner.progress(dir),
    error = state == "failed" and utils.trim(runner.read(dir, "error") or "") or nil,
    target = meta.target,
  }
end

---@param app_name string
---@return Job|nil
function queue.get(app_name)
  local dir = job_dir(app_name)
  local meta = read_meta(dir)
  return meta and build(dir, meta)
end

---Starts the oldest queued job if nothing is running
---@param entries JobEntry[]
local function promote(entries)
  ---@type JobEntry|nil
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

  -- Written by queue.start, and without them there's nothing to run
  local meta = next_up.meta
  if type(meta.exe) ~= "string" or type(meta.args) ~= "table" then
    log.warn("Dropping a queued job with nothing to run: " .. tostring(meta.app_name))
    fs.remove_all(next_up.dir)
    return
  end

  local started, err = runner.spawn(next_up.dir, meta.exe, meta.args)
  if not started then
    log.error("Could not start the queued " .. tostring(meta.kind) .. ": " .. tostring(err))
    return
  end

  log.info("Started the queued " .. tostring(meta.kind) .. " for " .. tostring(meta.app_name))
  next_up.job = build(next_up.dir, meta)
end

---Also moves the queue along
---@return Job[]
function queue.list()
  if not fs.is_directory(ROOT) then
    return {}
  end

  local entries = {}
  for _, entry in ipairs(fs.list(ROOT) or {}) do
    -- The directory name is a slug, so the app name comes out of the metadata
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

---Replaces the game's last job, and starts it in the same call if nothing else is running
---@param app_name string
---@param kind JobKind
---@param exe string
---@param args string[]
---@param target? string
---@return Job|nil job
---@return string? error
function queue.start(app_name, kind, exe, args, target)
  local existing = queue.get(app_name)
  if existing and (existing.state == "running" or existing.state == "queued") then
    return existing
  end

  -- Clear the old run, or the new one shows its last percentage until progress arrives
  local dir = job_dir(app_name)
  if fs.is_directory(dir) then
    fs.remove_all(dir)
  end
  fs.create_directories(dir)

  -- Stores the command, as whatever starts this job may be a poll minutes from now
  local ok, err = utils.write_file(
    runner.file(dir, "meta"),
    json.encode({
      app_name = app_name,
      kind = kind,
      started_at = datetime.unix(),
      exe = exe,
      args = args,
      target = target,
    })
  )
  if not ok then
    return nil, "Could not write the job: " .. tostring(err)
  end

  log.info("Queued " .. kind .. " for " .. app_name)

  queue.list()
  return queue.get(app_name)
end

---@param job Job
---@return boolean stopped
local function stop(job)
  if job.state ~= "running" and job.state ~= "queued" then
    return false
  end

  -- Before the kill, or a read in between calls the job failed, and for a queued job
  -- the marker alone takes it out of the queue
  utils.write_file(runner.file(job_dir(job.app_name), "paused"), "1")

  if job.state == "running" and job.pid then
    runner.kill(job.pid)
  end
  return true
end

---@ffi
---Polled while something downloads
---@return Job[]
function GetJobs()
  return queue.list()
end

---@ffi
---Keeps what has already been downloaded, and resuming is re-running the install
---@param app_name string
---@return boolean stopped
function PauseJob(app_name)
  local job = queue.get(app_name)
  if not job or not stop(job) then
    return false
  end

  log.info("Paused " .. app_name)
  return true
end

---@ffi
---Leaves what's on disk alone, as removing a partial install is uninstall's job
---@param app_name string
---@return boolean cancelled
function CancelJob(app_name)
  local job = queue.get(app_name)
  if not job then
    return false
  end

  stop(job)
  fs.remove_all(job_dir(app_name))
  log.info("Cancelled " .. app_name)
  return true
end

return queue
