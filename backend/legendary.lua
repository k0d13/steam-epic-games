--# selene: allow(unused_variable)
local DATA = require("data")
local disk = require("cache")
local fs = require("fs")
local jobs = require("jobs")
local json = require("json")
local log = require("log")
local shell = require("shell")
local utils = require("utils")
local vendor = require("vendor")

-- A wrapper around the `legendary` CLI (https://github.com/derrod/legendary),
-- which owns Epic's OAuth entirely - we never see a password or a token.

local legendary = {}

--- Where Epic sends the user to log in. The page it lands on prints the
--- authorization code we need.
local LOGIN_URL = "https://legendary.gl/epiclogin"

---@type string|nil
local BINARY = nil

---The legendary binary, downloading it if this machine hasn't got it yet.
---Public because a shortcut points at it - Steam launches legendary, not the
---game's own exe.
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

-- Commands --------------------------------------------------------------------

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
  -- The JSON arrives with legendary's log lines mixed in, and those look like
  -- "[cli] INFO: Logging in..." - so a search for the first "[" finds a log
  -- line, not the document.
  local lines = utils.split(output, "\n")
  for index, line in ipairs(lines) do
    local trimmed = utils.trim(line)
    local opens = trimmed:sub(1, 1)
    if (opens == "{" or opens == "[") and not is_log_line(trimmed) then
      -- Stops at the next log line rather than running to the end of the
      -- output: stdout and stderr share one pipe, so legendary's chatter can
      -- land on both sides of the document.
      local last = #lines
      for offset = index + 1, #lines do
        if is_log_line(utils.trim(lines[offset])) then
          last = offset - 1
          break
        end
      end

      local decoded = disk.decode(table.concat(lines, "\n", index, last))
      if decoded ~= nil then
        return decoded
      end
      return nil, "could not decode legendary output"
    end
  end

  -- Only the last error line, never the whole output: a legendary that fell over
  -- prints a Python traceback, and handing kilobytes of it back as an error
  -- string tells nobody anything.
  return nil, last_error(output) or utils.trim(output):sub(1, 200)
end

-- Status ----------------------------------------------------------------------

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

--- Cached: reading it costs a subprocess, and it's checked
--- on every panel render.
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

  -- The only command that reports the logged in account. It answers
  -- "<not logged in>" rather than failing when nobody is.
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
    -- Only when we came away with nothing: a decode complaint about the log
    -- lines around the document isn't a failure if the account came out of it.
    error = account == nil and decode_error or nil,
  }

  log.info("Status: account=" .. tostring(account))
  return status
end

---@ffi
---Is legendary runnable, and is an Epic account signed in? Cached, since
---answering costs a subprocess; pass `refresh` after anything that could have
---changed the answer.
---@param refresh? boolean
---@return EpicStatus
function get_status(refresh)
  return legendary.get_status(refresh)
end

---@ffi
---The command line Steam should use for one game's shortcut.
---
---It points at legendary, not the game's own executable: legendary waits on the
---game process, so playtime and "Currently playing" work, the shortcut survives
---Epic moving the exe, and it can exist before the game is installed.
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

-- Sizes ----------------------------------------------------------------------

-- How much room a game needs before it is installed, for the "Space Required"
-- Steam shows beside the Install button. `legendary list` does not carry it and
-- `legendary info` costs a manifest fetch per title, so it is read one game at a
-- time and cached by app name.
--
-- Nothing here can tell that a cached size has gone stale: knowing which build
-- it was measured against would cost the manifest fetch the cache exists to
-- avoid. So the frontend drops a game's size when a job touches it instead.

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
  sizes = sizes or disk.read(SIZES_PATH, "sizes") or {}
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
  disk.write(SIZES_PATH, sizes, "sizes")

  log.info("Sized " .. app_name .. ": " .. manifest.disk_size .. " bytes on disk")
  return sizes[app_name]
end

-- Achievements ---------------------------------------------------------------

-- Epic's achievements for one game, as `legendary achievements` reports them.
-- Read a game at a time and cached by app name, like sizes above.
--
-- Unlike a size, this answer really does go stale - the user unlocks things by
-- playing - so `fetched_at` rides along and the frontend decides when to ask
-- again.

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
  -- Every bucket, in the order Steam wants them read: unlocked first, then
  -- what's under way, then the rest.
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
  achievements = achievements or disk.read(ACHIEVEMENTS_PATH, "achievements") or {}
  if achievements[app_name] and not refresh then
    return achievements[app_name]
  end

  -- --hidden, because Steam draws undiscovered achievements itself, blurred,
  -- and dropping them here would leave its counts short of the total.
  local output = legendary.run({ "achievements", app_name, "--json", "--hidden" })
  local decoded, err = legendary.decode_json(output)

  -- Plenty of Epic games have no achievements at all, and legendary says so in
  -- a log line rather than an empty document. Cached like any other answer, or
  -- every session would ask Epic about them again.
  if type(decoded) ~= "table" and output:find("No achievements found", 1, true) then
    decoded = {}
  elseif type(decoded) ~= "table" then
    log.warn("Could not read achievements for " .. app_name .. ": " .. tostring(err))
    return nil
  end

  local result = build_achievements(decoded)
  achievements[app_name] = result
  disk.write(ACHIEVEMENTS_PATH, achievements, "achievements")

  log.info("Read achievements for " .. app_name .. ": " .. result.unlocked .. "/" .. result.total)
  return result
end

---@ffi
---Every game we already have achievements cached for, counts only.
---
---Reads nothing from Epic, so the frontend can ask about the whole library at
---once - which is what the library home's "% of Achievements Completed" sort
---needs, since it asks about every game as it draws.
---@return AchievementSummary[]
function get_cached_achievements()
  achievements = achievements or disk.read(ACHIEVEMENTS_PATH, "achievements") or {}

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

-- Long-running commands ------------------------------------------------------

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
---Install, update or resume a game. Returns as soon as the job is queued;
---progress is read back with `get_jobs`.
---
---legendary's `install` is also its update and its resume: pointed at a partial
---download, it continues from there.
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
---Update an already installed game.
---
---The same `install` underneath, since legendary fetches only the chunks that
---changed, but `--update-only` makes it refuse a game that isn't installed
---rather than quietly installing the whole thing.
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

-- Authentication --------------------------------------------------------------

-- `legendary auth --import` would lift a login out of the Epic Games Launcher
-- with no browser at all, but Epic allows one session per client id: importing
-- signs the user out of the launcher. Not something to do behind their back.

---@ffi
---Finish a sign in with the code from Epic's redirect page. The status that
---comes back carries an `error` when it didn't work.
---
---`--code` is the non-interactive form. Plain `legendary auth` blocks on stdin
---waiting for the code, and there is no stdin here.
---
---legendary exits 0 even when a login fails, so success is read by asking it who
---it thinks we are afterwards.
---@param code string The authorizationCode from Epic's redirect page
---@return EpicStatus
function sign_in(code)
  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  local current = legendary.get_status(true)
  if current.authenticated then
    return current
  end

  -- A copy, so the error doesn't stick to the cached status.
  local result = utils.merge({}, current)
  -- A failed attempt is not a no-op: legendary clears the stored login before
  -- trying the new code, so a bad code signs the user out. Hence the wording.
  result.error = last_error(output)
    or "That code didn't work, it may have expired or already been used. Press Sign in for a fresh one."
  return result
end

---@ffi
---Sign out, so the next sign in starts clean.
---@return EpicStatus
function sign_out()
  legendary.run({ "auth", "--delete" })
  return legendary.get_status(true)
end

return legendary
