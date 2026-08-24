local fs = require("fs")
local logger = require("logger")
local shell = require("shell")
local utils = require("utils")

-- Fetches the legendary binary on first use, from a release pinned by tag *and*
-- by SHA-256: a download that doesn't hash to exactly the bytes recorded below
-- is thrown away, so a compromised release or a hijacked CDN can't put a
-- different executable on a user's machine.
--
-- To upgrade, bump VERSION and replace SHA256 with the `digest` field GitHub
-- publishes for the asset:
--
--   curl -sL https://api.github.com/repos/legendary-gl/legendary/releases/latest
--
-- legendary is GPL-3.0, fetched unmodified and never redistributed by us.

local vendor = {}

local VERSION = "0.21.0"
local ASSET = "legendary_windows_x64.exe"
local SHA256 = "4c01a14c0acb0c46069b197ae7212ea4ea6b861661126ca0593cdac31658fb01"

local URL = "https://github.com/legendary-gl/legendary/releases/download/" .. VERSION .. "/" .. ASSET

--- Where the binary is kept. The name has no version in it because every Steam
--- shortcut points at this path: an upgrade replaces the file in place, which
--- the hash check notices on its own.
local DIR = utils.get_backend_path() .. "/vendor"
local PATH = DIR .. "/legendary.exe"

---The SHA-256 of a file, lowercase hex, or nil if it couldn't be hashed.
---certutil ships with Windows, so there's nothing to install.
---@param path string
---@return string|nil
local function digest(path)
  local output, code = shell.run("certutil", { "-hashfile", (path:gsub("/", "\\")), "SHA256" })
  if code ~= 0 then
    logger:warn("certutil could not hash " .. path .. ", exited " .. code)
    return nil
  end

  -- Matched a line at a time: the banner carries the path and the trailer starts
  -- with hex letters of its own, so reading the output as one run of characters
  -- glues them onto the digits this is after. Spaces inside the line are dropped
  -- because older certutil builds print the hash in byte pairs.
  for line in output:gmatch("[^\r\n]+") do
    local hash = line:gsub("%s", ""):match("^%x+$")
    if hash and #hash == 64 then return hash:lower() end
  end

  return nil
end

---Is the file at `path` the executable we pinned?
---@param path string
---@return boolean
local function verified(path)
  if not fs.is_file(path) then return false end
  return digest(path) == SHA256
end

---Fetch a URL to a file, blocking until it's there. The PowerShell fallback is
---for a Windows old enough to be missing curl.exe.
---@param destination string
---@return boolean ok
local function fetch(destination)
  local target = (destination:gsub("/", "\\"))

  -- Five minutes: this is a 30MB download over whatever connection the machine
  -- has, and the usual timeout would give up on a slow one.
  shell.run("curl.exe", { "-fsSL", "--retry", "2", "-o", target, URL }, { timeout = 300000 })
  if fs.is_file(destination) then return true end

  logger:info("curl did not produce a file, falling back to PowerShell")
  shell.run("powershell", {
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '"
    .. URL
    .. "' -OutFile '"
    .. target
    .. "'",
  }, { timeout = 300000 })

  return fs.is_file(destination)
end

---The legendary binary, downloading it if this machine hasn't got it yet.
---Blocks, since nothing here can do anything useful until it's there, and it
---only happens once per version.
---@return string|nil path
---@return string? error
function vendor.ensure()
  if verified(PATH) then return PATH end

  if fs.is_file(PATH) then
    logger:warn("Vendored legendary does not match the pin, refetching")
    fs.remove(PATH)
  end

  fs.create_directories(DIR)

  -- Downloaded under a temporary name and moved into place once verified, so an
  -- interrupted download is never mistaken for a usable binary.
  local partial = PATH .. ".part"
  if fs.is_file(partial) then fs.remove(partial) end

  logger:info("Fetching legendary " .. VERSION .. " from " .. URL)
  local started = utils.time_ms()
  if not fetch(partial) then
    return nil, "Could not download legendary. Check your connection and try again."
  end

  local actual = digest(partial)
  if actual ~= SHA256 then
    fs.remove(partial)
    logger:error("Checksum mismatch: expected " .. SHA256 .. ", got " .. tostring(actual))
    return nil, "The downloaded legendary did not match its checksum, so it was discarded."
  end

  if not fs.rename(partial, PATH) then
    fs.remove(partial)
    return nil, "Could not move the downloaded legendary into " .. PATH
  end

  logger:info("Vendored legendary " .. VERSION .. " to " .. PATH .. " in " .. (utils.time_ms() - started) .. "ms")
  return PATH
end

return vendor
