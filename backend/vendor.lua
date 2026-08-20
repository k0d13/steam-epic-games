local fs = require("fs")
local logger = require("logger")
local utils = require("utils")

-- Where the legendary binary comes from.
--
-- It used to be downloaded at build time and shipped inside the plugin, which
-- put a ~30 MB executable in every release and pushed the package past the
-- upload size limit. It is fetched on first use instead, from a release pinned
-- by tag *and* by SHA-256: the download is rejected unless it hashes to exactly
-- the bytes recorded below, so a compromised release, a hijacked CDN or a man
-- in the middle cannot slip a different executable onto a user's machine.
--
-- To upgrade, bump VERSION and replace SHA256 with the `digest` field GitHub
-- publishes for the asset:
--
--   curl -sL https://api.github.com/repos/legendary-gl/legendary/releases/latest
--
-- legendary is GPL-3.0. It is fetched unmodified from its own upstream release
-- and never redistributed by this plugin.

local vendor = {}

local VERSION = "0.21.0"
local ASSET = "legendary_windows_x64.exe"
local SHA256 = "4c01a14c0acb0c46069b197ae7212ea4ea6b861661126ca0593cdac31658fb01"

local URL = "https://github.com/legendary-gl/legendary/releases/download/" .. VERSION .. "/" .. ASSET

--- Where the binary is kept. get_backend_path() is the backend directory itself,
--- not a file inside it, so this hangs directly off it - the same place data/
--- already writes to.
---
--- Not named after the version: every Steam shortcut points at this path, so a
--- version bump that moved it would leave every shortcut launching a binary that
--- is no longer the one we check. Upgrades replace the file in place instead,
--- which the hash check below notices on its own.
local DIR = utils.get_backend_path() .. "/vendor"
local PATH = DIR .. "/legendary.exe"

---The SHA-256 of a file, lowercase hex, or nil if it couldn't be hashed.
---
---certutil ships with Windows, so this costs no second download and nothing
---extra to install. Its output is three lines - a banner, the hash, a trailer -
---with the hash the only run of 64 hex characters in it.
---@param path string
---@return string|nil
local function digest(path)
  local output = utils.exec('certutil -hashfile "' .. path:gsub("/", "\\") .. '" SHA256 2>&1')
  if not output then return nil end

  -- Frontiers so a 64-character run is not picked out of the middle of a longer
  -- one, which is the only other hex certutil could print.
  local hash = output:gsub("%s", ""):match("%f[%x]" .. ("%x"):rep(64) .. "%f[%X]")
  return hash and hash:lower() or nil
end

---Is the file at `path` the executable we pinned?
---@param path string
---@return boolean
local function verified(path)
  if not fs.is_file(path) then return false end
  return digest(path) == SHA256
end

---Fetch a URL to a file, blocking until it's there.
---
---curl.exe has shipped with Windows since 1803 and is the cheap path. The
---PowerShell fallback covers a machine old enough to be missing it, and costs a
---terminal flash and a second or two of startup, which is the right trade for a
---download that happens once.
---@param destination string
---@return boolean ok
local function fetch(destination)
  local target = destination:gsub("/", "\\")

  utils.exec('curl.exe -fsSL --retry 2 -o "' .. target .. '" "' .. URL .. '" 2>&1')
  if fs.is_file(destination) then return true end

  logger:info("curl did not produce a file, falling back to PowerShell")
  utils.exec(
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "'
      .. "$ProgressPreference='SilentlyContinue';"
      .. "Invoke-WebRequest -UseBasicParsing -Uri '"
      .. URL
      .. "' -OutFile '"
      .. target
      .. "'\" 2>&1"
  )

  return fs.is_file(destination)
end

---The legendary binary, downloading it if this machine hasn't got it yet.
---
---Blocking, and deliberately so: nothing in the backend can do anything useful
---without legendary, so there is no work to get on with while it downloads. It
---only ever happens once per version.
---@return string|nil path
---@return string? error
function vendor.ensure()
  if verified(PATH) then return PATH end

  if fs.is_file(PATH) then
    -- A truncated or tampered file. Nothing here will run it, so the only thing
    -- to do with it is replace it.
    logger:warn("Vendored legendary does not match the pin, refetching")
    fs.remove(PATH)
  end

  fs.create_directories(DIR)

  -- Downloaded beside the real name and moved into place once verified, so a
  -- download interrupted halfway can never be mistaken for a usable binary.
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
