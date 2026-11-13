local datetime = require("datetime")
local fs = require("fs")
local log = require("core.log")
local paths = require("core.paths")
local shell = require("core.shell")
local utils = require("utils")

-- legendary, pinned by tag and SHA-256 so a compromised release can't swap the exe
-- (GPL-3.0, fetched unmodified and never redistributed by us)
--
-- To upgrade, bump VERSION and set SHA256 to the asset's digest from
--   curl -sL https://api.github.com/repos/legendary-gl/legendary/releases/latest

local vendor = {}

local VERSION = "0.21.0"
local ASSET = paths.IS_WINDOWS and "legendary_windows_x64.exe" or "legendary_linux_x64"
local SHA256 = paths.IS_WINDOWS
    and "4c01a14c0acb0c46069b197ae7212ea4ea6b861661126ca0593cdac31658fb01"
  or "c83d1595a9e2cbae4e66b69ecaa1f8649da99b617a72f93312d342e6a5a799c7"

local URL = "https://github.com/legendary-gl/legendary/releases/download/"
  .. VERSION
  .. "/"
  .. ASSET

-- Unversioned because every Steam shortcut points here, and the hash check catches upgrades
local DIR = paths.DATA .. "/vendor"
local PATH = DIR .. (paths.IS_WINDOWS and "/legendary.exe" or "/legendary")

---Lowercase SHA-256 via certutil, which ships with Windows, or coreutils' sha256sum
---@param path string
---@return string|nil
local function digest(path)
  if not paths.IS_WINDOWS then
    local output, code = shell.run("sha256sum", { path })
    if code ~= 0 then
      log.warn("sha256sum could not hash " .. path .. ", exited " .. code)
      return nil
    end
    local hash = output:match("^(%x+)")
    return hash and #hash == 64 and hash:lower() or nil
  end

  local output, code = shell.run("certutil", { "-hashfile", shell.native_path(path), "SHA256" })
  if code ~= 0 then
    log.warn("certutil could not hash " .. path .. ", exited " .. code)
    return nil
  end

  -- Line by line, or the banner and trailer glue hex onto the digits, and spaces go
  -- because older certutil prints the hash in byte pairs
  for line in output:gmatch("[^\r\n]+") do
    local hash = line:gsub("%s", ""):match("^%x+$")
    if hash and #hash == 64 then
      return hash:lower()
    end
  end

  return nil
end

local DOWNLOAD = "legendary-download"
local DOWNLOADING = "Downloading legendary"

-- A failed download isn't retried on every status poll
local RETRY_SECONDS = 60
local failed_at = 0
local failure

-- Timed out, as a stalled connection would otherwise hold the download forever, and each
-- fallback skips itself if the one before produced the file
local function download_commands(target)
  local curl = {
    exe = paths.IS_WINDOWS and "curl.exe" or "curl",
    args = {
      "-fsSL",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--retry",
      "2",
      "-o",
      target,
      URL,
    },
  }

  if not paths.IS_WINDOWS then
    return {
      curl,
      {
        exe = "sh",
        args = {
          "-c",
          "[ -f "
            .. shell.sh_quote(target)
            .. " ] || wget -q -T 15 -O "
            .. shell.sh_quote(target)
            .. " "
            .. URL,
        },
      },
    }
  end

  return {
    curl,
    {
      exe = "powershell",
      args = {
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "if (!(Test-Path -LiteralPath "
          .. shell.ps_quote(target)
          .. ")) { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "
          .. shell.ps_quote(URL)
          .. " -OutFile "
          .. shell.ps_quote(target)
          .. " }",
      },
    },
  }
end

---@param message string
---@return nil
---@return string
local function fail(message)
  failed_at = datetime.unix()
  failure = message
  return nil, message
end

---@param partial string
---@param results { output: string, code: integer }[]
---@return string|nil path
---@return string? error
local function finish(partial, results)
  if not fs.is_file(partial) then
    for _, result in ipairs(results) do
      log.warn("Download step exited " .. result.code .. ": " .. utils.trim(result.output))
    end
    return fail("Could not download legendary. Check your connection and try again.")
  end

  local actual = digest(partial)
  if actual ~= SHA256 then
    fs.remove(partial)
    log.error("Checksum mismatch: expected " .. SHA256 .. ", got " .. tostring(actual))
    return fail("The downloaded legendary did not match its checksum, so it was discarded.")
  end

  if not paths.IS_WINDOWS then
    shell.run("chmod", { "+x", partial })
  end

  if not fs.rename(partial, PATH) then
    fs.remove(partial)
    return fail("Could not move the downloaded legendary into " .. PATH)
  end

  log.info("Vendored legendary " .. VERSION .. " to " .. PATH)
  return PATH
end

---For a retry the user asked for, which shouldn't wait out RETRY_SECONDS
function vendor.retry()
  failure = nil
end

---Downloaded once per version, in the background as nothing may hold the Lua state that long
---@return string|nil path
---@return string? error
---@return boolean? downloading True while the download runs, when error says so
function vendor.ensure()
  -- A temporary name, so an interrupted download never passes for the binary
  local partial = PATH .. ".part"

  local results = shell.collect(DOWNLOAD)
  if results then
    return finish(partial, results)
  end
  if shell.is_running(DOWNLOAD) then
    return nil, DOWNLOADING, true
  end

  if fs.is_file(PATH) then
    if digest(PATH) == SHA256 then
      return PATH
    end
    log.warn("Vendored legendary does not match the pin, refetching")
    fs.remove(PATH)
  end

  if failure and datetime.unix() - failed_at < RETRY_SECONDS then
    return nil, failure
  end

  fs.create_directories(DIR)
  if fs.is_file(partial) then
    fs.remove(partial)
  end

  log.info("Fetching legendary " .. VERSION .. " from " .. URL)
  local started, err = shell.start(DOWNLOAD, download_commands(shell.native_path(partial)))
  if not started then
    return fail("Could not start downloading legendary: " .. tostring(err))
  end
  failure = nil
  return nil, DOWNLOADING, true
end

return vendor
