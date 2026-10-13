--# selene: allow(unused_variable)
local cache = require("cache")
local fs = require("fs")
local jobs = require("jobs")
local json = require("json")
local log = require("log")
local DATA = log.DATA
local shell = require("shell")
local utils = require("utils")
local vendor = require("vendor")

-- A wrapper around the `legendary` CLI (https://github.com/derrod/legendary),
-- which owns Epic's OAuth entirely - we never see a password or a token.

local legendary = {}

--- Epic's login, which lands on a page printing the authorization code.
local LOGIN_URL = "https://legendary.gl/epiclogin"

---@type string|nil
local BINARY = nil

---The legendary binary, downloaded on first use. Public because shortcuts launch
---legendary rather than the game's exe.
---@return string|nil path
---@return string? error
function legendary.get_binary()
  if BINARY and fs.is_file(BINARY) then
    return BINARY
  end

  local path, err = vendor.ensure()
  BINARY = path
  return path, err
end

---The subcommand out of one argument list, for a log line.
---@param args string[]
---@return string
local function subcommand(args)
  for _, arg in ipairs(args) do
    if arg:sub(1, 1) ~= "-" then
      return arg
    end
  end
  return "?"
end

---Run one legendary command and block until it exits.
---@param args string[] Arguments to legendary, unquoted
---@return string output stdout followed by stderr, empty if the binary is missing
---@return integer status -1 if there was nothing to run
function legendary.run(args)
  local binary, err = legendary.get_binary()
  if not binary then
    log.error("No legendary binary: " .. tostring(err))
    return "", -1
  end

  local started = utils.time_ms()
  local output, status = shell.run(binary, args)

  local summary = subcommand(args) .. " in " .. (utils.time_ms() - started) .. "ms"
  if status == 0 then
    log.info("Ran " .. summary)
  else
    log.warn("Ran " .. summary .. ", exited " .. status)
  end

  return output, status
end

---Is this one of legendary's own log lines, like "[cli] INFO: Logging in..."?
---@param trimmed string
---@return boolean
local function is_log_line(trimmed)
  return trimmed:match("^%[[%w%-%._]+%]%s+%u+:") ~= nil
end

---The last error line in some legendary output, if it printed one.
---@param output string
---@return string|nil
local function last_error(output)
  local last
  for line in output:gmatch("[^\r\n]+") do
    if line:find("ERROR:") or line:find("CRITICAL:") then
      last = utils.trim(line)
    end
  end
  return last
end

---Decode the JSON a legendary command printed.
---@param output string
---@return any|nil decoded
---@return string? error
function legendary.decode_json(output)
  -- Log lines like "[cli] INFO: ..." also start with "[", so they're skipped.
  local lines = utils.split(output, "\n")
  for index, line in ipairs(lines) do
    local trimmed = utils.trim(line)
    local opens = trimmed:sub(1, 1)
    if (opens == "{" or opens == "[") and not is_log_line(trimmed) then
      -- Stop at the next log line: stderr shares the pipe and can follow the document.
      local last = #lines
      for offset = index + 1, #lines do
        if is_log_line(utils.trim(lines[offset])) then
          last = offset - 1
          break
        end
      end

      local decoded = cache.decode(table.concat(lines, "\n", index, last))
      if decoded ~= nil then
        return decoded
      end
      return nil, "could not decode legendary output"
    end
  end

  -- Only the last error line, not the Python traceback a crash prints.
  return nil, last_error(output) or utils.trim(output):sub(1, 200)
end

---@class EpicStatus
---@field available boolean Is the binary present
---@field authenticated boolean Is there a logged in Epic account
---@field account string|nil Epic display name, when authenticated
---@field login_url string Where to send the user to sign in
---@field error string|nil Why we couldn't read a status, or why signing in failed

---@class LaunchCommand
---@field exe string
---@field arguments string
---@field start_dir string

--- Cached: reading it costs a subprocess, and every panel render checks it.
---@type EpicStatus|nil
local status = nil

---@param refresh boolean|nil Re-read rather than using the cached answer
---@return EpicStatus
function legendary.get_status(refresh)
  if status and not refresh then
    return status
  end

  local binary, err = legendary.get_binary()
  if not binary then
    status = {
      available = false,
      authenticated = false,
      login_url = LOGIN_URL,
      error = err,
    }
    return status
  end

  -- The only command that reports the account; prints "<not logged in>" for nobody.
  local output = legendary.run({ "status", "--json" })
  local decoded, decode_error = legendary.decode_json(output)

  local account = type(decoded) == "table" and decoded.account or nil
  if account == json.null or account == "<not logged in>" then
    account = nil
  end

  status = {
    available = true,
    authenticated = account ~= nil,
    account = account,
    login_url = LOGIN_URL,
    -- A decode complaint doesn't matter if the account came out anyway.
    error = account == nil and decode_error or nil,
  }

  log.info("Status: account=" .. tostring(account))
  return status
end

---@ffi
---Is legendary runnable, and is an Epic account signed in? Cached; pass `refresh`
---after anything that could change the answer.
---@param refresh? boolean
---@return EpicStatus
function get_status(refresh)
  return legendary.get_status(refresh)
end

---@ffi
---A game's shortcut command. It runs legendary, which waits on the game so playtime
---works, survives Epic moving the exe, and works before the game is installed.
---@param app_name string
---@return LaunchCommand|nil
function get_launch_command(app_name)
  local binary = legendary.get_binary()
  if not binary then
    return nil
  end

  return {
    exe = binary,
    arguments = 'launch "' .. app_name .. '"',
    start_dir = binary:match("^(.*)[\\/]") or "",
  }
end

-- Steam's "Space Required", one manifest fetch per game and cached with no way to
-- tell it's stale, so the frontend drops a game's size when a job touches it.

---@class GameSize
---@field disk integer Bytes the installed game occupies - what Steam calls "Space Required"
---@field download integer Bytes actually transferred, which is smaller: Epic ships compressed

local SIZES_PATH = DATA .. "/cache/sizes.json"

---@type table<string, GameSize>|nil
local sizes = nil

---@ffi
---What one game needs on disk. A miss costs a manifest fetch from Epic.
---@param app_name string
---@param refresh? boolean Re-read even if it's cached
---@return GameSize|nil
function get_game_size(app_name, refresh)
  sizes = sizes or cache.read(SIZES_PATH, "sizes") or {}
  if sizes[app_name] and not refresh then
    return sizes[app_name]
  end

  local decoded, err = legendary.decode_json(legendary.run({ "info", app_name, "--json" }))
  -- No manifest means legendary could not reach Epic.
  local manifest = type(decoded) == "table" and decoded.manifest or nil
  if type(manifest) ~= "table" or type(manifest.disk_size) ~= "number" then
    log.warn("Could not size " .. app_name .. ": " .. tostring(err))
    return nil
  end

  sizes[app_name] = {
    disk = manifest.disk_size,
    download = manifest.download_size or manifest.disk_size,
  }
  cache.write(SIZES_PATH, sizes, "sizes")

  log.info("Sized " .. app_name .. ": " .. manifest.disk_size .. " bytes on disk")
  return sizes[app_name]
end

-- Cached per game like sizes, but these go stale as the user plays, so `fetched_at`
-- lets the frontend decide when to ask again.

local ACHIEVEMENTS_PATH = DATA .. "/cache/achievements.json"

---@class Achievement
---@field id string Epic's internal name, unique within the game
---@field name string Display name
---@field description string
---@field unlocked boolean
---@field progress number 0 to 1
---@field unlocked_at string|nil Epic's timestamp, like "2026-06-12 21:21:24.391000+00:00"
---@field icon string|nil Icon URL, already locked or unlocked as appropriate
---@field rarity number|nil Percent of players holding it
---@field hidden boolean Undiscovered, so Steam blurs it

---@class GameAchievements
---@field total integer
---@field unlocked integer
---@field fetched_at integer Unix seconds
---@field achievements Achievement[]

---@class AchievementSummary
---@field app_name string
---@field total integer
---@field unlocked integer
---@field fetched_at integer Unix seconds

---@type table<string, GameAchievements>|nil
local achievements = nil

---Flatten one of legendary's four buckets into our own shape.
---@param entries table[]|nil
---@param out Achievement[]
local function collect_achievements(entries, out)
  if type(entries) ~= "table" then
    return
  end

  for _, entry in ipairs(entries) do
    table.insert(out, {
      id = entry.name,
      name = entry.display_name or entry.name,
      description = entry.description or "",
      unlocked = entry.unlocked == true,
      progress = entry.progress or 0,
      unlocked_at = type(entry.unlock_date) == "string" and entry.unlock_date or nil,
      icon = entry.icon_link,
      rarity = (entry.rarity or {}).percent,
      hidden = entry.hidden == true,
    })
  end
end

---Turn one `legendary achievements --json` document into a GameAchievements.
---@param decoded table
---@return GameAchievements
local function build_achievements(decoded)
  local list = {}
  -- Steam's order: unlocked, in progress, then the rest.
  collect_achievements(decoded.completed, list)
  collect_achievements(decoded.in_progress, list)
  collect_achievements(decoded.uninitiated, list)
  collect_achievements(decoded.hidden, list)

  return {
    total = decoded.total_achievements or #list,
    unlocked = decoded.user_unlocked or 0,
    fetched_at = math.floor(utils.time()),
    achievements = list,
  }
end

---@ffi
---One game's achievements. A miss costs a round trip to Epic.
---@param app_name string
---@param refresh? boolean Ask Epic again even if it's cached
---@return GameAchievements|nil
function get_achievements(app_name, refresh)
  achievements = achievements or cache.read(ACHIEVEMENTS_PATH, "achievements") or {}
  if achievements[app_name] and not refresh then
    return achievements[app_name]
  end

  -- --hidden, since Steam blurs undiscovered ones itself and its counts need them.
  local output = legendary.run({ "achievements", app_name, "--json", "--hidden" })
  local decoded, err = legendary.decode_json(output)

  -- "None" comes as a log line, not a document. Cached anyway, or every session asks again.
  if type(decoded) ~= "table" and output:find("No achievements found", 1, true) then
    decoded = {}
  elseif type(decoded) ~= "table" then
    log.warn("Could not read achievements for " .. app_name .. ": " .. tostring(err))
    return nil
  end

  local result = build_achievements(decoded)
  achievements[app_name] = result
  cache.write(ACHIEVEMENTS_PATH, achievements, "achievements")

  log.info("Read achievements for " .. app_name .. ": " .. result.unlocked .. "/" .. result.total)
  return result
end

---@ffi
---Cached achievement counts for every game, without asking Epic, for the library's
---"% of Achievements Completed" sort.
---@return AchievementSummary[]
function get_cached_achievements()
  achievements = achievements or cache.read(ACHIEVEMENTS_PATH, "achievements") or {}

  local summaries = {}
  for app_name, entry in pairs(achievements) do
    table.insert(summaries, {
      app_name = app_name,
      total = entry.total,
      unlocked = entry.unlocked,
      fetched_at = entry.fetched_at,
    })
  end

  return summaries
end

---Queue a legendary command as a job.
---@param app_name string
---@param kind JobKind
---@param args string[]
---@return Job|nil
local function start_job(app_name, kind, args)
  local binary, err = legendary.get_binary()
  local job
  if binary then
    job, err = jobs.start(app_name, kind, binary, args)
  end

  if not job then
    log.warn("Could not start the " .. kind .. " of " .. app_name .. ": " .. tostring(err))
  end
  return job
end

---@ffi
---Install, update or resume a game; progress comes back through `get_jobs`.
---legendary's `install` resumes a partial download in place.
---@param app_name string
---@param base_path? string Parent directory to install into, legendary's default if nil
---@param game_folder? string Directory name inside it
---@return Job|nil
function start_install(app_name, base_path, game_folder)
  local args = { "-y", "install", app_name }

  if type(base_path) == "string" and base_path ~= "" then
    table.insert(args, "--base-path")
    table.insert(args, (base_path:gsub("/", "\\")))
  end
  if type(game_folder) == "string" and game_folder ~= "" then
    table.insert(args, "--game-folder")
    table.insert(args, game_folder)
  end

  return start_job(app_name, "install", args)
end

---@ffi
---Update an installed game. `--update-only` refuses one that isn't installed
---rather than quietly installing it.
---@param app_name string
---@return Job|nil
function start_update(app_name)
  return start_job(app_name, "update", { "-y", "install", app_name, "--update-only" })
end

---@ffi
---Remove a game from disk. The Steam shortcut is left alone, since keeping
---uninstalled games in the library is the point of the plugin.
---@param app_name string
---@return Job|nil
function start_uninstall(app_name)
  return start_job(app_name, "uninstall", { "-y", "uninstall", app_name })
end

-- Not `legendary auth --import`: Epic allows one session per client id, so it
-- would sign the user out of the Epic Games Launcher.

---@ffi
---Finish a sign in with the code from Epic's redirect page; `error` is set on
---failure. legendary exits 0 either way, so success is read from its status.
---@param code string The authorizationCode from Epic's redirect page
---@return EpicStatus
function sign_in(code)
  log.info("Signing in with a code from the store's session")
  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  local current = legendary.get_status(true)
  if current.authenticated then
    return current
  end

  -- A copy, so the error doesn't stick to the cached status.
  local result = utils.merge({}, current)
  -- legendary clears the stored login before trying a code, so a bad one signs out.
  result.error = last_error(output)
    or "That code didn't work, it may have expired or already been used. Press Sign in for a fresh one."
  return result
end

---@ffi
---Sign out, so the next sign in starts clean.
---@return EpicStatus
function sign_out()
  log.info("Signing out, the store is signed out")
  legendary.run({ "auth", "--delete" })
  return legendary.get_status(true)
end

return legendary
