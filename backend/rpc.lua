local grid = require("grid")
local jobs = require("jobs")
local json = require("json")
local legendary = require("legendary")
local library = require("library")
local sizes = require("sizes")

-- Every method takes one JSON payload and answers with one JSON document. The
-- wrapper below is the whole convention, so each method here is only the part
-- that differs.

---Wrap a handler so it takes and returns JSON.
---@param handler fun(data: table): table|nil
---@return fun(payload: string): string
local function method(handler)
  return function(payload)
    local result = handler(json.decode(payload))
    -- Cannot return nothing or nil alone, because Millennium tries to stoi it.
    if not result then return "null" end
    return json.encode(result)
  end
end

---@class RPC
local RPC = {}

-- Setup -----------------------------------------------------------------------

---Is legendary runnable, and is an Epic account signed in?
RPC.GetStatus = method(function(data)
  return legendary.get_status(data.refresh == true)
end)

---Exchange the code from Epic's redirect page for a stored login.
---
---The browser half of this happens in the frontend, which opens LOGIN_URL. We
---never see the user's Epic password: legendary trades this one-shot code for
---its own tokens and stores them under %USERPROFILE%\.config\legendary.
RPC.SignIn = method(function(data)
  local ok, err = legendary.authenticate(data.code)
  if not ok then return { ok = false, error = err } end

  -- Not a refresh: authenticate() re-read the status to decide whether it
  -- worked, so asking again would only cost another terminal flash.
  return { ok = true, status = legendary.get_status() }
end)

RPC.SignOut = method(function()
  legendary.sign_out()
  -- Same as SignIn: sign_out() already left the cached status current.
  return { ok = true, status = legendary.get_status() }
end)

-- Library ---------------------------------------------------------------------

---Everything the account owns, merged with what's installed on disk.
---
---Answers from the cache by default, which is empty until something has asked
---for a refresh: a cold `legendary list` hits Epic and takes a few seconds on a
---large account, so it is never done behind the user's back. Pass `refresh` to
---read it, and `force` to also bypass legendary's own catalog cache.
---
---`installed` is the cheap middle setting. It re-reads what's on disk without
---going out to Epic at all, which is everything an install can have changed.
RPC.GetLibrary = method(function(data)
  local games, err
  if data.installed then
    games, err = library.refresh_installed()
  elseif data.refresh then
    games, err = library.refresh(data.force == true)
  else
    games = library.get()
  end

  if not games then return { ok = false, error = err } end
  return { ok = true, games = games, refreshed_at = library.get_refreshed_at() }
end)

---The command line Steam should use for one game's shortcut.
---
---It points at legendary rather than at the game's own executable on purpose.
---legendary waits on the game process, so Steam sees a real running app, and
---playtime, "Currently playing" and Recently Played all work. It stays correct
---when Epic patches or moves the exe, and it means a shortcut can exist before
---the game is installed at all.
RPC.GetLaunchCommand = method(function(data)
  local binary = legendary.get_binary()
  if not binary then return { ok = false } end

  return {
    ok = true,
    exe = binary,
    arguments = 'launch "' .. data.app_name .. '"',
    start_dir = binary:match("^(.*)[\\/]") or "",
  }
end)

---How much room one game needs on disk, for the "Space Required" Steam shows
---beside the Install button.
---
---Not part of GetLibrary: reading it costs a manifest fetch from Epic per game,
---and it's only ever displayed one game at a time. Cached in the backend, so
---this is slow once per game and instant after that.
RPC.GetGameSize = method(function(data)
  local size, err = sizes.get(data.app_name, data.refresh == true)
  if not size then return { ok = false, error = err } end
  return { ok = true, disk = size.disk, download = size.download }
end)

-- Installs --------------------------------------------------------------------

---Start installing, updating or resuming one game.
---
---Returns as soon as the job is spawned. The install itself runs detached and
---its progress is read back with GetJobs. Starting a game that is already
---installing is a no-op that returns the running job.
RPC.StartInstall = method(function(data)
  local job, err = jobs.install(data.app_name, data.base_path, data.game_folder)
  if not job then return { ok = false, error = err } end
  return { ok = true, job = job }
end)

---Remove a game from disk. The Steam shortcut is left alone, since keeping
---uninstalled games in the library is the point of the plugin.
RPC.StartUninstall = method(function(data)
  local job, err = jobs.uninstall(data.app_name)
  if not job then return { ok = false, error = err } end
  return { ok = true, job = job }
end)

---Every install or uninstall we know about, running or finished.
---
---This is what the frontend polls while something is downloading, so it stays
---cheap: the runner writes its own progress to a small file and this only reads
---it back.
RPC.GetJobs = method(function()
  return { ok = true, jobs = jobs.list() }
end)

---Stop a running install, keeping what's already downloaded. legendary has no
---pause of its own, so this kills it; StartInstall is the resume.
RPC.PauseJob = method(function(data)
  return { ok = jobs.pause(data.app_name) }
end)

---Stop a job and forget it. What's on disk is left where it is.
RPC.CancelJob = method(function(data)
  return { ok = jobs.cancel(data.app_name) }
end)

-- Artwork ---------------------------------------------------------------------

---Move the icon Steam just wrote into the name Steam reads icons back from.
---
---The frontend hands the bytes to Steam, which saves us decoding base64 and
---writing binary from Lua; the renaming Steam leaves undone is grid.lua's job.
RPC.PlaceIcon = method(function(data)
  local path, err = grid.place_icon(data.app_id, data.account_id)
  if not path then return { ok = false, error = err } end
  return { ok = true, path = path }
end)

return { RPC = RPC }
