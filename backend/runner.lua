local datetime = require("datetime")
local fs = require("fs")
local paths = require("paths")
local shell = require("shell")
local utils = require("utils")

-- `shell.run` would block the Lua state for a whole download, so a job's command
-- runs in a detached PowerShell (a /bin/sh script on Linux) that reports through
-- small files in its directory.

local runner = {}

--- The files in a job directory. The runner script refers to them as `{lock}` etc.
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

--- legendary runs in a pipeline so `taskkill /T` on this PID takes it down too.
--- Progress and errors get files of their own so reads never scan the log.
local SCRIPT = [[
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

SCRIPT = SCRIPT:gsub("{(%w+)}", FILES)

--- The same runner for Linux. Started under setsid, so killing the negative PID
--- takes legendary down too. awk keeps POSIX: no capture groups, so a progress
--- line is split on its punctuation instead, and the directory comes in through
--- ENVIRON because `-v` would read its backslashes as escapes.
local POSIX_SCRIPT = [=[
echo $$ > "$DIR/{pid}"

# A subshell, so legendary's exit code survives the pipe. It lands under a
# temporary name and is moved in once awk has written everything else.
(
  # The blank line answers a prompt -y doesn't cover; see the PowerShell runner.
  printf '\n' | "$EXE" "$@" 2>&1
  echo $? > "$DIR/{exit}.part"
) | DIR="$DIR" awk '
  BEGIN { dir = ENVIRON["DIR"]; percent = 0; done = 0; total = 0; eta = ""; elapsed = ""; speed = 0 }
  {
    print >> (dir "/{log}"); fflush(dir "/{log}")

    if ($0 ~ /Progress: [0-9.]+% \([0-9]+\/[0-9]+\), Running for [0-9:]+, ETA: [0-9:]+/) {
      line = $0; sub(/.*Progress: /, "", line); gsub(/[%(),\/]/, " ", line)
      split(line, f, " ")
      percent = f[1]; done = f[2]; total = f[3]; elapsed = f[6]; eta = f[8]
    } else if ($0 ~ /Download[ \t]+- [0-9.]+ MiB\/s \(raw\)/) {
      line = $0; sub(/.*Download[ \t]+- /, "", line)
      split(line, f, " "); speed = f[1]
    } else {
      if ($0 ~ /(ERROR|CRITICAL):/) { print > (dir "/{error}"); close(dir "/{error}") }
      next
    }

    status = dir "/{status}"
    printf "percent=%s\ndownloaded=%s\ntotal=%s\neta=%s\nelapsed=%s\nspeed=%s\n",
      percent, done, total, eta, elapsed, speed > status
    close(status)
  }
'

mv "$DIR/{exit}.part" "$DIR/{exit}"
]=]

POSIX_SCRIPT = POSIX_SCRIPT:gsub("{(%w+)}", FILES)

---Start a detached runner on Linux. `&` inside the command, since `utils.exec`
---waits for it.
---@param dir string
---@param exe string
---@param args string[]
---@return boolean started
---@return string? error
local function spawn_posix(dir, exe, args)
  local quoted = {}
  for index, arg in ipairs(args) do
    quoted[index] = shell.sh_quote(arg)
  end

  local script = "DIR="
    .. shell.sh_quote(dir)
    .. "\nEXE="
    .. shell.sh_quote(exe)
    .. "\nset -- "
    .. table.concat(quoted, " ")
    .. "\n"
    .. POSIX_SCRIPT

  local script_path = runner.file(dir, "script")
  local ok, err = utils.write_file(script_path, script)
  if not ok then
    return false, "Could not write the job script: " .. tostring(err)
  end

  utils.write_file(runner.file(dir, "spawned"), tostring(datetime.unix()))

  utils.exec("setsid sh " .. shell.sh_quote(script_path) .. " </dev/null >/dev/null 2>&1 &")
  return true
end

---Start a hidden, detached runner. Through wscript because `utils.exec` waits
---for the command to finish.
---@param dir string
---@param exe string The program the runner owns
---@param args string[] Arguments to it
---@return boolean started
---@return string? error
function runner.spawn(dir, exe, args)
  if not paths.IS_WINDOWS then
    return spawn_posix(dir, exe, args)
  end

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
    .. SCRIPT

  local script_path = runner.file(dir, "script")
  local ok, err = utils.write_file(script_path, script)
  if not ok then
    return false, "Could not write the job script: " .. tostring(err)
  end

  local launcher_path = runner.file(dir, "launcher")
  ok, err = utils.write_file(launcher_path, shell.vbs_launcher(script_path))
  if not ok then
    return false, "Could not write the job launcher: " .. tostring(err)
  end

  -- Before the launch, or a read in between sees it queued and starts a second runner.
  utils.write_file(runner.file(dir, "spawned"), tostring(datetime.unix()))

  shell.run("wscript", { shell.native_path(launcher_path) })
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
