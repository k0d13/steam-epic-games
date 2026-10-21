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

---@param destination string
---@return boolean ok
local function fetch(destination)
  local target = shell.native_path(destination)

  local output, code = shell.run(
    paths.IS_WINDOWS and "curl.exe" or "curl",
    { "-fsSL", "--retry", "2", "-o", target, URL }
  )
  if fs.is_file(destination) then
    return true
  end
  log.warn("curl exited " .. code .. ": " .. output)

  -- Not every distro ships curl, and Ubuntu's desktop image has wget instead
  if not paths.IS_WINDOWS then
    output, code = shell.run("wget", { "-q", "-O", target, URL })
    if code == 0 and fs.is_file(destination) then
      return true
    end
    log.warn("wget exited " .. code .. ": " .. output)
    return false
  end

  log.info("curl did not produce a file, falling back to PowerShell")
  shell.run("powershell", {
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri "
      .. shell.ps_quote(URL)
      .. " -OutFile "
      .. shell.ps_quote(target),
  })

  return fs.is_file(destination)
end

---Downloaded once per version, and blocks as nothing works without it
---@return string|nil path
---@return string? error
function vendor.ensure()
  if fs.is_file(PATH) then
    if digest(PATH) == SHA256 then
      return PATH
    end
    log.warn("Vendored legendary does not match the pin, refetching")
    fs.remove(PATH)
  end

  fs.create_directories(DIR)

  -- A temporary name, so an interrupted download never passes for the binary
  local partial = PATH .. ".part"
  if fs.is_file(partial) then
    fs.remove(partial)
  end

  log.info("Fetching legendary " .. VERSION .. " from " .. URL)
  local started = utils.time_ms()
  if not fetch(partial) then
    return nil, "Could not download legendary. Check your connection and try again."
  end

  local actual = digest(partial)
  if actual ~= SHA256 then
    fs.remove(partial)
    log.error("Checksum mismatch: expected " .. SHA256 .. ", got " .. tostring(actual))
    return nil, "The downloaded legendary did not match its checksum, so it was discarded."
  end

  if not paths.IS_WINDOWS then
    shell.run("chmod", { "+x", partial })
  end

  if not fs.rename(partial, PATH) then
    fs.remove(partial)
    return nil, "Could not move the downloaded legendary into " .. PATH
  end

  log.info(
    "Vendored legendary "
      .. VERSION
      .. " to "
      .. PATH
      .. " in "
      .. (utils.time_ms() - started)
      .. "ms"
  )
  return PATH
end

return vendor
