local grid = require("grid")
local jobs = require("jobs")
local json = require("json")
local legendary = require("legendary")
local library = require("library")
local logger = require("logger")
local text = require("text")
local trace = require("trace")
local utils = require("utils")

-- Every method takes one JSON payload and answers with one JSON document.

--- Polled once a second while a download is going, so tracing every one of
--- these would bury everything else in the file. Only traced when it fails or
--- takes long enough to be worth knowing about.
local QUIET = { GetJobs = true }

--- What counts as long enough, for calls that are otherwise instant.
local SLOW_MS = 250

---Walk a handler's answer and make every string in it encodable. Keys as well
---as values, since a game name can be either.
---@param value any
---@param seen table<table, table>
---@param report { replaced: integer, window: string|nil }
---@return any
local function sanitise(value, seen, report)
  if type(value) == "string" then
    local scrubbed, replaced, position = text.scrub(value)
    if replaced > 0 and position then
      report.replaced = report.replaced + replaced
      report.window = report.window or text.window(value, position)
    end
    return scrubbed
  end
  if type(value) ~= "table" then
    return value
  end
  if seen[value] then
    return seen[value]
  end

  local copy = {}
  seen[value] = copy
  for key, item in pairs(value) do
    copy[sanitise(key, seen, report)] = sanitise(item, seen, report)
  end
  return copy
end

---Note that a call finished.
---@param name string
---@param started integer
---@param fields table<string, any>
local function record(name, started, fields)
  local elapsed = utils.time_ms() - started
  if QUIET[name] and elapsed < SLOW_MS then
    return
  end

  fields.method = name
  fields.ms = elapsed
  trace.event("rpc", fields)
end

---Wrap a handler so it takes and returns JSON.
---
---Nothing here is allowed to throw: an error raised inside a handler unwinds
---into Millennium rather than back to the caller, which loses the call and the
---reason for it. So every half answers with a document instead.
---@param name string
---@param handler fun(data: table): table|nil
---@return fun(payload: string): string
local function method(name, handler)
  return function(payload)
    local started = utils.time_ms()

    local read, data = pcall(json.decode, payload)
    if not read or type(data) ~= "table" then
      trace.anomaly("rpc.payload", { method = name, bytes = #payload })
      return json.encode({ ok = false, error = "Malformed request payload" })
    end

    local ok, result = pcall(handler, data)
    if not ok then
      logger:error("RPC handler failed: " .. tostring(result))
      trace.anomaly("rpc.failed", { method = name, error = tostring(result) })
      return json.encode({ ok = false, error = (text.scrub(tostring(result))) })
    end

    -- Cannot return nothing or nil alone, because Millennium tries to stoi it.
    if not result then
      record(name, started, {})
      return "null"
    end

    local report = { replaced = 0 }
    -- Both halves inside the pcall, not just the encode: an argument is
    -- evaluated before the call that protects it, so sanitising out here would
    -- put its errors exactly where this whole function exists to keep them from
    -- going. Encoding throws on its own as well, for anything cjson can't
    -- represent - a number that isn't finite, a value type with no JSON
    -- equivalent.
    local wrote, encoded = pcall(function()
      return json.encode(sanitise(result, {}, report))
    end)
    if not wrote then
      logger:error("RPC response could not be encoded: " .. tostring(encoded))
      trace.anomaly("rpc.encode", { method = name, error = tostring(encoded) })
      return json.encode({ ok = false, error = "Response could not be encoded" })
    end

    -- Worth a line of its own: this is the shape that used to reach Millennium's
    -- parser and take the whole host down with it.
    if report.replaced > 0 then
      trace.anomaly(
        "rpc.invalid_utf8",
        { method = name, replaced = report.replaced, bytes = report.window }
      )
    end

    record(name, started, { bytes = #encoded })
    return encoded
  end
end

---@class RPC
local RPC = {}

-- Setup -----------------------------------------------------------------------

---Is legendary runnable, and is an Epic account signed in?
RPC.GetStatus = function(data)
  return legendary.get_status(data.refresh == true)
end

---Exchange the code from Epic's redirect page for a stored login. The browser
---half happens in the frontend. We never see the password - legendary trades
---the code for its own tokens and stores them.
RPC.SignIn = function(data)
  local ok, err = legendary.authenticate(data.code)
  if not ok then
    return { ok = false, error = err }
  end

  -- authenticate() already re-read the status to decide whether it worked.
  return { ok = true, status = legendary.get_status() }
end

RPC.SignOut = function()
  legendary.sign_out()
  -- sign_out() already left the cached status current.
  return { ok = true, status = legendary.get_status() }
end

-- Library ---------------------------------------------------------------------

---Everything the account owns, merged with what's installed on disk.
---
---Answers from the cache by default, since a cold `legendary list` takes a few
---seconds on a large account and shouldn't happen behind the user's back. Pass
---`refresh` to read it, `force` to also bypass legendary's own catalog cache,
---or `installed` to re-read just what's on disk.
RPC.GetLibrary = function(data)
  local games, err
  if data.installed then
    games, err = library.refresh_installed()
  elseif data.refresh then
    games, err = library.refresh(data.force == true)
  else
    games = library.get()
  end

  if not games then
    return { ok = false, error = err }
  end
  return { ok = true, games = games, refreshed_at = library.get_refreshed_at() }
end

---The command line Steam should use for one game's shortcut.
---
---It points at legendary, not the game's own executable: legendary waits on the
---game process, so playtime and "Currently playing" work, the shortcut survives
---Epic moving the exe, and it can exist before the game is installed.
RPC.GetLaunchCommand = function(data)
  local binary = legendary.get_binary()
  if not binary then
    return { ok = false }
  end

  return {
    ok = true,
    exe = binary,
    arguments = 'launch "' .. data.app_name .. '"',
    start_dir = binary:match("^(.*)[\\/]") or "",
  }
end

---How much room one game needs on disk, for the "Space Required" Steam shows
---beside the Install button. Kept out of GetLibrary because it costs a manifest
---fetch per game; slow once per game, cached after that.
RPC.GetGameSize = function(data)
  local size, err, still_running = legendary.get_size(data.app_name, data.refresh == true)
  -- Answered rather than waited for: the frontend asks again after retry_in
  -- milliseconds, and everything else keeps working meanwhile.
  if still_running then
    return { pending = true, retry_in = 500 }
  end
  if not size then
    return { ok = false, error = err }
  end
  return { ok = true, disk = size.disk, download = size.download }
end

---One game's achievements, as Epic has them. Costs a round trip to Epic on a
---miss, cached in the backend after that; pass `refresh` to re-read one that
---has gone stale because the game has been played since.
RPC.GetAchievements = function(data)
  local result, err, still_running = legendary.get_achievements(data.app_name, data.refresh == true)
  -- Answered rather than waited for, the same way GetGameSize is.
  if still_running then
    return { pending = true, retry_in = 500 }
  end
  if not result then
    return { ok = false, error = err }
  end

  -- Copied rather than flagged in place: the table is legendary's cache entry,
  -- and an `ok` written into it would be persisted with it.
  return {
    ok = true,
    total = result.total,
    unlocked = result.unlocked,
    fetched_at = result.fetched_at,
    achievements = result.achievements,
  }
end

---What we already know about every game's achievements, counts only, straight
---from the cache. Never touches Epic, so the frontend can seed the whole
---library's completion percentages in one call.
RPC.GetCachedAchievements = function()
  -- A list rather than a map keyed by app name: the frontend camelises every
  -- key it gets back, and an app name is not a key it should be rewriting.
  local games = {}
  for app_name, summary in pairs(legendary.get_cached_achievements()) do
    table.insert(games, {
      app_name = app_name,
      total = summary.total,
      unlocked = summary.unlocked,
      fetched_at = summary.fetched_at,
    })
  end

  return { ok = true, games = games }
end

-- Installs --------------------------------------------------------------------

---Start installing, updating or resuming one game. Returns as soon as the job
---is spawned; progress is read back with GetJobs. Starting a game that is
---already installing returns the running job.
RPC.StartInstall = function(data)
  local job, err = legendary.install(data.app_name, data.base_path, data.game_folder)
  if not job then
    return { ok = false, error = err }
  end
  return { ok = true, job = job }
end

---Update an installed game to the latest build. The same job machinery as an
---install, and the same queue - only one legendary runs at a time.
RPC.StartUpdate = function(data)
  local job, err = legendary.update(data.app_name)
  if not job then
    return { ok = false, error = err }
  end
  return { ok = true, job = job }
end

---Remove a game from disk. The Steam shortcut is left alone, since keeping
---uninstalled games in the library is the point of the plugin.
RPC.StartUninstall = function(data)
  local job, err = legendary.uninstall(data.app_name)
  if not job then
    return { ok = false, error = err }
  end
  return { ok = true, job = job }
end

---Every install or uninstall we know about, running or finished. Polled while
---something is downloading, so it only reads the small files the runner writes.
RPC.GetJobs = function()
  return { ok = true, jobs = jobs.list() }
end

---Stop a running install, keeping what's already downloaded. legendary has no
---pause of its own, so this kills it; StartInstall is the resume.
RPC.PauseJob = function(data)
  return { ok = jobs.pause(data.app_name) }
end

---Stop a job and forget it. What's on disk is left where it is.
RPC.CancelJob = function(data)
  return { ok = jobs.cancel(data.app_name) }
end

-- Artwork ---------------------------------------------------------------------

---Move the icon Steam just wrote into the name Steam reads icons back from.
---The frontend hands Steam the bytes; this is the part Steam leaves undone.
RPC.PlaceIcon = function(data)
  local path, err = grid.place_icon(data.app_id, data.account_id)
  if not path then
    return { ok = false, error = err }
  end
  return { ok = true, path = path }
end

-- Wrapped in one pass rather than at each definition, so a method cannot be
-- added without its JSON handling, and so the name a trace line carries is the
-- one the frontend called.
for name, handler in pairs(RPC) do
  RPC[name] = method(name, handler)
end

return { RPC = RPC }
