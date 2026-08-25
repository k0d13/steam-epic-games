local disk = require("cache")
local fs = require("fs")
local jobs = require("jobs")
local json = require("json")
local logger = require("logger")
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

  -- Always with a reason, so every caller can hand the error straight on
  -- rather than inventing wording of its own.
  if not path then
    return nil, err or "legendary binary not found"
  end
  return path
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
---@param timeout integer|nil Milliseconds to wait, `shell.run`'s default if nil
---@return string output stdout followed by stderr, empty if the binary is missing
---@return integer status -1 if there was nothing to run
function legendary.run(args, timeout)
  local binary, err = legendary.get_binary()
  if not binary then
    logger:error("No legendary binary: " .. tostring(err))
    return "", -1
  end

  local started = utils.time_ms()
  local output, status = shell.run(binary, args, { timeout = timeout })

  local summary = subcommand(args) .. " in " .. (utils.time_ms() - started) .. "ms"
  if status == 0 then
    logger:info("Ran " .. summary)
  else
    logger:warn("Ran " .. summary .. ", exited " .. status)
  end

  return output, status
end

---Is this one of legendary's own log lines, like "[cli] INFO: Logging in..."?
---@param trimmed string
---@return boolean
local function is_log_line(trimmed)
  return trimmed:match("^%[[%w%-%._]+%]%s+%u+:") ~= nil
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
      -- output: stderr is appended after stdout, so legendary's chatter lands
      -- on both sides of the document.
      local last = #lines
      for offset = index + 1, #lines do
        if is_log_line(utils.trim(lines[offset])) then
          last = offset - 1
          break
        end
      end

      local ok, decoded = pcall(json.decode, table.concat(lines, "\n", index, last))
      if ok then
        return decoded
      end
      return nil, "could not decode legendary output: " .. tostring(decoded)
    end
  end

  return nil, utils.trim(output)
end

---The last error line in some legendary output, if it printed one.
---@param output string
---@return string|nil
function legendary.last_error(output)
  local last
  for line in output:gmatch("[^\r\n]+") do
    if line:find("ERROR:") or line:find("CRITICAL:") then
      last = utils.trim(line)
    end
  end
  return last
end

-- Status ----------------------------------------------------------------------

---@class LegendaryStatus
---@field available boolean Is the binary present
---@field authenticated boolean Is there a logged in Epic account
---@field account string|nil Epic display name, when authenticated
---@field login_url string Where to send the user to sign in
---@field error string|nil Why we couldn't read a status

--- Cached: reading it costs a subprocess, and it's checked
--- on every panel render.
---@type LegendaryStatus|nil
local status = nil

---@param refresh boolean|nil Re-read rather than using the cached answer
---@return LegendaryStatus
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
      error = err or "legendary could not be downloaded.",
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

  logger:info("Status: account=" .. tostring(account))
  return status
end

---Start a legendary command without waiting for it, for work too slow to hold
---the Lua state for. Collect it with `legendary.collect`.
---@param args string[] Arguments to legendary, unquoted
---@return string|nil id
---@return string? error
function legendary.start(args)
  local binary, err = legendary.get_binary()
  if not binary then
    return nil, err
  end

  return shell.start(binary, args)
end

---The output of a command started with `legendary.start`, or nil while it is
---still running. Answers once: collecting it clears it.
---@param id string
---@return string|nil output
function legendary.collect(id)
  return shell.poll(id)
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

local SIZES_PATH = utils.get_backend_path() .. "/data/cache/sizes.json"

---@type table<string, GameSize>|nil
local sizes = nil

--- The `legendary info` still running for a game, by app name, so asking twice
--- while the first is in flight waits on that one.
---@type table<string, string>
local sizing = {}

---What one game needs on disk.
---
---A miss costs a manifest fetch from Epic, several seconds of it, which is far
---too long to hold the Lua state for. So a miss starts the command and says so;
---the caller asks again, and the answer is there once it is. Never blocks.
---@param app_name string
---@param refresh boolean|nil Re-read even if it's cached
---@return GameSize|nil size
---@return string? error
---@return boolean? still_running The command has been started, ask again shortly
function legendary.get_size(app_name, refresh)
  if type(app_name) ~= "string" or app_name == "" then
    return nil, "No app name provided"
  end

  sizes = sizes or disk.read(SIZES_PATH, "sizes") or {}
  if sizes[app_name] and not refresh then
    return sizes[app_name]
  end

  local id = sizing[app_name]
  if not id then
    local started, err = legendary.start({ "info", app_name, "--json" })
    if not started then
      return nil, err
    end

    sizing[app_name] = started
    return nil, nil, true
  end

  local output = legendary.collect(id)
  if not output then
    return nil, nil, true
  end
  sizing[app_name] = nil

  local decoded, err = legendary.decode_json(output)
  if type(decoded) ~= "table" then
    return nil, err or "legendary returned no info"
  end

  -- No manifest means legendary could not reach Epic, which is the offline
  -- answer rather than a failure worth showing.
  local manifest = decoded.manifest
  if type(manifest) ~= "table" or type(manifest.disk_size) ~= "number" then
    return nil, "no manifest for " .. app_name
  end

  sizes[app_name] = {
    disk = manifest.disk_size,
    download = manifest.download_size or manifest.disk_size,
  }
  disk.write(SIZES_PATH, sizes, "sizes")

  logger:info("Sized " .. app_name .. ": " .. manifest.disk_size .. " bytes on disk")
  return sizes[app_name]
end

-- Achievements ---------------------------------------------------------------

-- Epic's achievements for one game, as `legendary achievements` reports them.
-- Read a game at a time and cached by app name, like sizes above: the command
-- talks to Epic, so it is far too slow to hold the Lua state for.
--
-- Unlike a size, this answer really does go stale - the user unlocks things by
-- playing - so `fetched_at` rides along and the frontend decides when to ask
-- again.

local ACHIEVEMENTS_PATH = utils.get_backend_path() .. "/data/cache/achievements.json"

---@class Achievement
---@field id string Epic's internal name, unique within the game
---@field name string Display name
---@field description string
---@field unlocked boolean
---@field progress number 0 to 1
---@field unlocked_at string|nil Epic's timestamp, parsed by the frontend
---@field icon string|nil Icon URL, already locked or unlocked as appropriate
---@field rarity number|nil Percent of players holding it
---@field hidden boolean Undiscovered, so Steam blurs it

---@class GameAchievements
---@field total integer
---@field unlocked integer
---@field fetched_at integer Unix seconds
---@field achievements Achievement[]

---@type table<string, GameAchievements>|nil
local achievements = nil

--- The `legendary achievements` still running for a game, by app name.
---@type table<string, string>
local achieving = {}

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

---One game's achievements.
---
---Started and collected the way `get_size` is: a miss says so rather than
---waiting, and the caller asks again shortly. Never blocks.
---@param app_name string
---@param refresh boolean|nil Ask Epic again even if it's cached
---@return GameAchievements|nil result
---@return string? error
---@return boolean? still_running The command has been started, ask again shortly
function legendary.get_achievements(app_name, refresh)
  if type(app_name) ~= "string" or app_name == "" then
    return nil, "No app name provided"
  end

  achievements = achievements or disk.read(ACHIEVEMENTS_PATH, "achievements") or {}
  if achievements[app_name] and not refresh then
    return achievements[app_name]
  end

  local id = achieving[app_name]
  if not id then
    -- --hidden, because Steam draws undiscovered achievements itself, blurred,
    -- and dropping them here would leave its counts short of the total.
    local started, err = legendary.start({ "achievements", app_name, "--json", "--hidden" })
    if not started then
      return nil, err
    end

    achieving[app_name] = started
    return nil, nil, true
  end

  local output = legendary.collect(id)
  if not output then
    return nil, nil, true
  end
  achieving[app_name] = nil

  local decoded, err = legendary.decode_json(output)

  -- Plenty of Epic games have no achievements at all, and legendary says so in
  -- a log line rather than an empty document. Cached like any other answer, or
  -- every session would ask Epic about them again.
  if type(decoded) ~= "table" and output:find("No achievements found", 1, true) then
    decoded = {}
  elseif type(decoded) ~= "table" then
    return nil, err or "legendary returned no achievements"
  end

  local result = build_achievements(decoded)
  achievements[app_name] = result
  disk.write(ACHIEVEMENTS_PATH, achievements, "achievements")

  logger:info(
    "Read achievements for " .. app_name .. ": " .. result.unlocked .. "/" .. result.total
  )
  return result
end

---Every game we already have achievements cached for, counts only.
---
---Reads nothing from Epic and starts nothing, so the frontend can ask about the
---whole library at once - which is what the library home's "% of Achievements
---Completed" sort needs, since it asks about every game as it draws and a
---command per game would be a subprocess storm.
---@return table<string, { total: integer, unlocked: integer, fetched_at: integer }>
function legendary.get_cached_achievements()
  achievements = achievements or disk.read(ACHIEVEMENTS_PATH, "achievements") or {}

  local summaries = {}
  for app_name, entry in pairs(achievements) do
    summaries[app_name] = {
      total = entry.total,
      unlocked = entry.unlocked,
      fetched_at = entry.fetched_at,
    }
  end

  return summaries
end

-- Long-running commands ------------------------------------------------------

---Install, update or resume a game, as a job rather than a wait.
---
---legendary's `install` is also its update and its resume: pointed at a partial
---download, it continues from there.
---@param app_name string
---@param base_path string|nil Parent directory to install into, legendary's default if nil
---@param game_folder string|nil Directory name inside it
---@return Job|nil job
---@return string? error
function legendary.install(app_name, base_path, game_folder)
  local binary, err = legendary.get_binary()
  if not binary then
    return nil, err
  end

  local args = { "-y", "install", app_name }

  if type(base_path) == "string" and base_path ~= "" then
    table.insert(args, "--base-path")
    table.insert(args, (base_path:gsub("/", "\\")))
  end
  if type(game_folder) == "string" and game_folder ~= "" then
    table.insert(args, "--game-folder")
    table.insert(args, game_folder)
  end

  return jobs.start(app_name, "install", binary, args)
end

---Update an already installed game, as a job.
---
---The same `install` underneath, since legendary fetches only the chunks that
---changed, but `--update-only` makes it refuse a game that isn't installed
---rather than quietly installing the whole thing.
---@param app_name string
---@return Job|nil job
---@return string? error
function legendary.update(app_name)
  local binary, err = legendary.get_binary()
  if not binary then
    return nil, err
  end

  return jobs.start(app_name, "update", binary, { "-y", "install", app_name, "--update-only" })
end

---@param app_name string
---@return Job|nil job
---@return string? error
function legendary.uninstall(app_name)
  local binary, err = legendary.get_binary()
  if not binary then
    return nil, err
  end

  return jobs.start(app_name, "uninstall", binary, { "-y", "uninstall", app_name })
end

-- Authentication --------------------------------------------------------------

-- `legendary auth --import` would lift a login out of the Epic Games Launcher
-- with no browser at all, but Epic allows one session per client id: importing
-- signs the user out of the launcher. Not something to do behind their back.

---Finish a sign in with the code from Epic's redirect page.
---
---`--code` is the non-interactive form. Plain `legendary auth` blocks on stdin
---waiting for the code, and there is no stdin here.
---
---legendary exits 0 even when a login fails, so success is read by asking it who
---it thinks we are afterwards.
---@param code string The authorizationCode from Epic's redirect page
---@return boolean success
---@return string? error
function legendary.authenticate(code)
  if type(code) ~= "string" or utils.trim(code) == "" then
    return false, "No code provided"
  end

  local output = legendary.run({ "auth", "--code", utils.trim(code) })
  if legendary.get_status(true).authenticated then
    return true
  end

  -- A failed attempt is not a no-op: legendary clears the stored login before
  -- trying the new code, so a bad code signs the user out. Hence the wording.
  return false,
    legendary.last_error(output)
      or "That code didn't work, it may have expired or already been used. Press Sign in for a fresh one."
end

---Sign out, so the next sign in starts clean.
---@return boolean success
function legendary.sign_out()
  legendary.run({ "auth", "--delete" })
  return not legendary.get_status(true).authenticated
end

return legendary
