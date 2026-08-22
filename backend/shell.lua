local fs = require("fs")
local json = require("json")
local logger = require("logger")
local utils = require("utils")

-- Somewhere to run a command that isn't `utils.exec`.
--
-- `utils.exec` goes through cmd, and Steam has no console for cmd to borrow, so
-- every call allocates one: a window that flashes up on screen and takes focus
-- with it. Once a second, which is what polling a download used to cost, that is
-- unusable.
--
-- So one PowerShell is started at load - hidden, and the only window this plugin
-- flashes at all - and left running. It watches `data/daemon/req` for a request,
-- runs it, and writes the output and the exit code back into `data/daemon/res`;
-- this module writes the one and waits for the other. Since that PowerShell is
-- already up, a command also stops paying for a process launch.
--
-- `shell.run` still blocks the Lua state for as long as the command takes; what
-- it doesn't do is put a window on screen. `shell.start` is the one that comes
-- back straight away, and work too long even for that belongs in `jobs.lua`.

local shell = {}

local ROOT = utils.get_backend_path() .. "/data/daemon"
local ROOT_WIN = (ROOT:gsub("/", "\\"))
local REQUESTS = ROOT .. "/req"
local RESPONSES = ROOT .. "/res"
local LOCK = ROOT .. "/daemon.lock"
local STAMP = ROOT .. "/version"
local STOP = ROOT .. "/stop"

--- Long enough that a slow `legendary list` on a big library finishes, short
--- enough that a daemon which has wedged doesn't hang Steam forever.
local TIMEOUT = 120000

--- How long to leave the daemon alone after it failed to start, so a machine
--- where it can't run doesn't retry the launch on every single command.
local RETRY_AFTER = 30000

-- Small helpers ---------------------------------------------------------------

---A cheap fingerprint of a string.
---
---Used on the daemon script, so a daemon still running from before an edit is
---replaced rather than left quietly serving the old code.
---@param text string
---@return string
local function fingerprint(text)
  local sum = 0
  for index = 1, #text do
    sum = (sum * 31 + text:byte(index)) % 4294967291
  end
  return #text .. "-" .. sum
end

--- What to multiply milliseconds by to get whatever unit `utils.sleep` takes,
--- measured once rather than assumed: guessing seconds when it wants
--- milliseconds only wastes a poll, guessing the other way round freezes Steam.
---@type number|nil
local sleep_scale = nil

---Sleep for roughly `ms` milliseconds.
---@param ms number
local function nap(ms)
  if not sleep_scale then
    local started = utils.time_ms()
    pcall(utils.sleep, 1)
    -- A whole second back from an argument of 1 means the argument is seconds.
    sleep_scale = (utils.time_ms() - started) >= 500 and 0.001 or 1
  end

  pcall(utils.sleep, ms * sleep_scale)
end

---Is `path` a lock file that some process is holding open?
---
---Windows refuses every other open of a file opened unshared, so a write that
---fails is a process still holding it. Costs no process of its own, which is
---the point: asking the OS for a process list is what used to flash a window.
---@param path string
---@return boolean
function shell.is_locked(path)
  if not fs.is_file(path) then return false end

  local ok, wrote = pcall(utils.write_file, path, "")
  return not (ok and wrote ~= false)
end

---Escape a string for a single-quoted PowerShell literal.
---@param value string
---@return string
function shell.ps_quote(value)
  return "'" .. value:gsub("'", "''") .. "'"
end

---A one line VBScript that runs `command` with no window at all and doesn't
---wait for it.
---
---`WScript.Shell.Run` with a window style of 0 is the only way to start a
---console application and see nothing: `powershell -WindowStyle Hidden` still
---flashes one, because by the time PowerShell can hide the window it exists.
---@param command string A command line, already quoted
---@return string
function shell.vbs_launcher(command)
  return 'CreateObject("WScript.Shell").Run "' .. command:gsub('"', '""') .. '", 0, False'
end

-- The daemon ------------------------------------------------------------------

--- Started with `$Root` and `$MutexName` defined above it.
---
--- Requests run side by side rather than one after another, so a slow one does
--- not hold up the rest. Each is answered as two files: the output first, then
--- the exit code renamed into place, since a caller that has seen the code has
--- to be able to read the output beside it.
local DAEMON = [==[
$ErrorActionPreference = 'Continue'

# One daemon per plugin, so a second launch - a Steam restart racing the daemon
# of the session before it - stops here instead of fighting over the requests.
$Mutex = New-Object System.Threading.Mutex($false, $MutexName)
if (-not $Mutex.WaitOne(0)) { exit }

# Held unshared for as long as this process lives, so the plugin can tell the
# daemon is up by trying to open it.
$Lock = [System.IO.File]::Open("$Root\daemon.lock", 'Create', 'Write', 'None')

$Requests = "$Root\req"
$Responses = "$Root\res"
New-Item -ItemType Directory -Force -Path $Requests, $Responses | Out-Null

# No BOM: the plugin reads these back looking for the first character of a JSON
# document, and a byte order mark would be it.
$Utf8 = New-Object System.Text.UTF8Encoding $false

$Watcher = New-Object System.IO.FileSystemWatcher $Requests, '*.json'
$Running = New-Object System.Collections.ArrayList
$Checked = [datetime]::MinValue

# PowerShell 5.1 has no ProcessStartInfo.ArgumentList, so the command line is
# built by hand to the rules CommandLineToArgvW reads back: double the run of
# backslashes before a quote or before the end, and quote anything with a space.
function Quote-Argument($Value) {
  if ($Value -eq '') { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $Escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $Escaped = [regex]::Replace($Escaped, '(\\*)$', '$1$1')
  return '"' + $Escaped + '"'
}

function Answer($Id, $Output, $Code) {
  [System.IO.File]::WriteAllText("$Responses\$Id.out", $Output, $Utf8)
  # Renamed into place last: the plugin waits on this file, so its arrival has
  # to mean the output beside it is complete.
  [System.IO.File]::WriteAllText("$Responses\$Id.pending", [string]$Code)
  Move-Item -Force -Path "$Responses\$Id.pending" -Destination "$Responses\$Id.code"
}

while ($true) {
  # Nothing to serve once Steam has gone, and nobody left to ask us to stop.
  if (((Get-Date) - $Checked).TotalSeconds -ge 5) {
    $Checked = Get-Date
    if (Test-Path "$Root\stop") { break }
    if (-not (Get-Process -Name steam -ErrorAction SilentlyContinue)) { break }
  }

  foreach ($File in @(Get-ChildItem -Path $Requests -Filter '*.json' -ErrorAction SilentlyContinue)) {
    $Id = $File.BaseName
    try {
      $Request = Get-Content -Raw -Encoding utf8 -Path $File.FullName | ConvertFrom-Json
      # Removed before it runs rather than after: a request that kills this
      # process should time out on the plugin side, not be retried forever.
      Remove-Item -Force -Path $File.FullName

      $Quoted = @()
      foreach ($Argument in @($Request.arguments)) {
        # A request with no arguments decodes to an object rather than a list.
        if ($Argument -is [string]) { $Quoted += Quote-Argument $Argument }
      }

      $Start = New-Object System.Diagnostics.ProcessStartInfo
      $Start.FileName = $Request.exe
      $Start.Arguments = $Quoted -join ' '
      $Start.UseShellExecute = $false
      # Without this a console application started from here would be given a
      # console of its own, which is the window this whole daemon exists to
      # avoid.
      $Start.CreateNoWindow = $true
      $Start.RedirectStandardOutput = $true
      $Start.RedirectStandardError = $true
      if ($Request.cwd) { $Start.WorkingDirectory = $Request.cwd }

      $Process = [System.Diagnostics.Process]::Start($Start)
      # Read as tasks, not one after the other: a program that fills one pipe
      # while nothing drains the other deadlocks.
      $Running.Add(@{
        Id = $Id
        Process = $Process
        Out = $Process.StandardOutput.ReadToEndAsync()
        Err = $Process.StandardError.ReadToEndAsync()
      }) | Out-Null
    } catch {
      Answer $Id "$_" -1
    }
  }

  foreach ($Job in @($Running)) {
    if (-not $Job.Process.HasExited) { continue }
    $Job.Process.WaitForExit()

    # stdout then stderr rather than interleaved, which suits the one caller
    # that cares: legendary prints its JSON to stdout and its log lines to
    # stderr, and this way the document is not buried in them.
    Answer $Job.Id ($Job.Out.Result + $Job.Err.Result) $Job.Process.ExitCode
    $Job.Process.Dispose()
    $Running.Remove($Job)
  }

  if ($Running.Count -gt 0) {
    Start-Sleep -Milliseconds 25
  } else {
    # Blocks until a request lands or the timeout comes round for the checks
    # above, so an idle daemon costs nothing at all.
    $Watcher.WaitForChanged('Created', 1000) | Out-Null
  }
}
]==]

--- Not the daemon's fingerprint: two daemons with different scripts still can't
--- both own the request directory.
local MUTEX = "epic-games-shell-" .. fingerprint(ROOT)

local FINGERPRINT = fingerprint(DAEMON)

---@return string
local function stamp()
  if not fs.is_file(STAMP) then return "" end
  return utils.trim(utils.read_file(STAMP) or "")
end

---@type integer
local retry_after = 0

---Write the daemon out and start it.
---@return boolean started
local function launch()
  -- Whatever the last session left behind. A response nobody is waiting for any
  -- more, from a command that timed out, would otherwise sit there for good.
  fs.remove_all(REQUESTS)
  fs.remove_all(RESPONSES)
  fs.create_directories(REQUESTS)
  fs.create_directories(RESPONSES)

  local script = "$Root = "
      .. shell.ps_quote(ROOT_WIN)
      .. "\n$MutexName = "
      .. shell.ps_quote(MUTEX)
      .. "\n"
      .. DAEMON

  local ok, err = utils.write_file(ROOT .. "/daemon.ps1", script)
  if not ok then
    logger:error("Could not write the daemon: " .. tostring(err))
    retry_after = utils.time_ms() + RETRY_AFTER
    return false
  end

  utils.write_file(STAMP, FINGERPRINT)
  utils.write_file(
    ROOT .. "/daemon.vbs",
    shell.vbs_launcher(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' .. ROOT_WIN .. '\\daemon.ps1"'
    )
  )

  -- The one console window left, at startup rather than once a second.
  utils.exec('wscript "' .. ROOT_WIN .. '\\daemon.vbs"')

  local deadline = utils.time_ms() + 10000
  while not shell.is_locked(LOCK) do
    if utils.time_ms() > deadline then
      logger:warn("Command daemon did not start, falling back to blocking commands")
      retry_after = utils.time_ms() + RETRY_AFTER
      return false
    end
    nap(20)
  end

  logger:info("Command daemon ready")
  return true
end

---Make sure a daemon running the current script is up. Cheap enough to call in
---front of every command: the usual answer is one failed file open.
---@return boolean available
function shell.ensure()
  if shell.is_locked(LOCK) then
    if stamp() == FINGERPRINT then return true end

    -- The script has been edited since that daemon started, which only happens
    -- while developing. It polls for this file and exits when it sees it.
    logger:info("Command daemon is out of date, restarting it")
    utils.write_file(STOP, "1")

    local deadline = utils.time_ms() + 10000
    while shell.is_locked(LOCK) and utils.time_ms() < deadline do
      nap(50)
    end
    fs.remove(STOP)
  end

  if utils.time_ms() < retry_after then return false end
  return launch()
end

-- Running a command -----------------------------------------------------------

---Quote a single argument for cmd.exe.
---@param arg string
---@return string
local function cmd_quote(arg)
  return '"' .. arg:gsub('"', '\\"') .. '"'
end

---Run a command the old way, for when the daemon could not be started.
---
---Flashes a window, which is the whole thing this module exists to avoid, but a
---plugin that works badly beats one that doesn't work.
---@param exe string
---@param args string[]
---@return string output
---@return integer code
local function fallback(exe, args)
  local parts = { cmd_quote(exe) }
  for _, arg in ipairs(args) do
    table.insert(parts, cmd_quote(arg))
  end

  -- Wrapped in one more pair of quotes: this runs through `cmd /c`, which strips
  -- the outermost pair before parsing, and without it the path to the executable
  -- loses its quotes and splits at its first space.
  local output, status = utils.exec('"' .. table.concat(parts, " ") .. ' 2>&1"')
  return output or "", tonumber(status) or -1
end

---Queue a program and return without waiting for it.
---
---Requests run side by side, so two of these overlap rather than queue.
---@param exe string
---@param args string[]|nil
---@param options { cwd?: string }|nil
---@return string|nil id Hand this to `shell.poll`
---@return string? error
function shell.start(exe, args, options)
  options = options or {}

  local arguments = {}
  for index, arg in ipairs(args or {}) do
    arguments[index] = tostring(arg)
  end

  if not shell.ensure() then return nil, "The command daemon is not running" end

  local id = utils.uuid()
  local payload = json.encode({ exe = exe, arguments = arguments, cwd = options.cwd })

  -- Written under another name and renamed in, so the daemon can never pick up
  -- half a request. It only watches for `.json`.
  local partial = REQUESTS .. "/" .. id .. ".part"
  local ok, err = utils.write_file(partial, payload)
  if not ok or not fs.rename(partial, REQUESTS .. "/" .. id .. ".json") then
    return nil, "Could not queue the command: " .. tostring(err)
  end

  return id
end

---Has the command finished? Nil while it is still going, and the files are
---cleaned up by the read that collects them, so an id answers once.
---@param id string
---@return string|nil output
---@return integer? code
function shell.poll(id)
  local out_path = RESPONSES .. "/" .. id .. ".out"
  local code_path = RESPONSES .. "/" .. id .. ".code"
  if not fs.is_file(code_path) then return nil end

  local output = utils.read_file(out_path) or ""
  local code = tonumber(utils.trim(utils.read_file(code_path) or "")) or -1

  if fs.is_file(out_path) then fs.remove(out_path) end
  fs.remove(code_path)

  return output, code
end

---Give up on a command that is still queued, so its answer is never collected.
---@param id string
function shell.forget(id)
  for _, path in ipairs({
    REQUESTS .. "/" .. id .. ".json",
    RESPONSES .. "/" .. id .. ".out",
    RESPONSES .. "/" .. id .. ".code",
  }) do
    if fs.is_file(path) then fs.remove(path) end
  end
end

---Run a program and block until it exits.
---@param exe string
---@param args string[]|nil
---@param options { cwd?: string, timeout?: integer }|nil
---@return string output stdout followed by stderr
---@return integer code -1 if the command could not be run at all
function shell.run(exe, args, options)
  options = options or {}

  local id, err = shell.start(exe, args, options)
  if not id then
    logger:warn(tostring(err))
    local arguments = {}
    for index, arg in ipairs(args or {}) do
      arguments[index] = tostring(arg)
    end
    return fallback(exe, arguments)
  end

  local deadline = utils.time_ms() + (options.timeout or TIMEOUT)
  while true do
    local output, code = shell.poll(id)
    if output then return output, code or -1 end

    if utils.time_ms() > deadline then
      logger:warn("Command timed out: " .. exe)
      shell.forget(id)
      return "", -1
    end
    nap(5)
  end
end

return shell
