local grid = require("grid")
local jobs = require("jobs")
local json = require("json")
local legendary = require("legendary")
local library = require("library")
local sizes = require("sizes")

---@return fun(payload: string): string
local function rpcmethod(func)
  return function(payload)
    local data = json.decode(payload)
    local result = func(data)
    if result then
      return json.encode(result)
    else
      -- Cannot return nothing or nil alone because Millennium tries to stoi it.
      return "null"
    end
  end
end

---@class RPC
local RPC = {}

function RPC.new()
  local self = setmetatable({}, { __index = RPC })
  return self
end

-- Setup -----------------------------------------------------------------------

---Is legendary runnable, and is an Epic account signed in?
---@param payload string
---@return string
function RPC.GetStatus(payload)
  local wrapped_func = rpcmethod(function(data)
    return legendary.get_status(data.refresh == true)
  end)
  return wrapped_func(payload)
end

---Exchange the code from Epic's redirect page for a stored login.
---
---The browser half of this happens in the frontend, which opens LOGIN_URL. We
---never see the user's Epic password - legendary trades this one-shot code for
---its own tokens and stores them under %USERPROFILE%\.config\legendary.
---@param payload string
---@return string
function RPC.SignIn(payload)
  local wrapped_func = rpcmethod(function(data)
    local ok, err = legendary.authenticate(data.code)
    if not ok then return { ok = false, error = err } end
    -- Not a refresh: authenticate() re-read the status to decide whether it
    -- worked, so asking again would only cost another terminal flash.
    return { ok = true, status = legendary.get_status() }
  end)
  return wrapped_func(payload)
end

---@param payload string
---@return string
function RPC.SignOut(payload)
  local wrapped_func = rpcmethod(function()
    legendary.sign_out()
    -- Same as SignIn: sign_out() already left the cached status current.
    return { ok = true, status = legendary.get_status() }
  end)
  return wrapped_func(payload)
end

-- Library ---------------------------------------------------------------------

---Everything the account owns, merged with what's installed on disk.
---
---Answers from the cache by default, which is empty until something has asked
---for a refresh - a cold `legendary list` hits Epic and takes a few seconds on a
---large account, so it is never done behind the user's back. Pass `refresh` to
---read it, and `force` to also bypass legendary's own catalog cache.
---
---`installed` is the cheap middle setting: it re-reads what's on disk without
---going out to Epic at all, which is everything an install can have changed.
---@param payload string
---@return string
function RPC.GetLibrary(payload)
  local wrapped_func = rpcmethod(function(data)
    local games, err = library.get()
    if data.installed then
      games, err = library.refresh_installed()
    elseif data.refresh then
      games, err = library.refresh(data.force == true)
    end

    if not games then return { ok = false, error = err } end
    return { ok = true, games = games, refreshed_at = library.get_refreshed_at() }
  end)
  return wrapped_func(payload)
end

---The command line Steam should use for one game's shortcut.
---
---It points at legendary rather than at the game's own executable on purpose.
---legendary waits on the game process, so Steam sees a real running app -
---playtime, "Currently playing" and Recently Played all work - and it stays
---correct when Epic patches or moves the exe. It also means a shortcut can
---exist before the game is installed at all.
---@param payload string
---@return string
function RPC.GetLaunchCommand(payload)
  local wrapped_func = rpcmethod(function(data)
    local binary = legendary.get_binary()
    if not binary then return { ok = false } end

    return {
      ok = true,
      exe = binary,
      arguments = 'launch "' .. data.app_name .. '"',
      start_dir = binary:match("^(.*)[\\/]") or "",
    }
  end)
  return wrapped_func(payload)
end

---How much room one game needs on disk, for the "Space Required" Steam shows
---beside the Install button.
---
---Not part of GetLibrary: reading it costs a manifest fetch from Epic per game,
---and it's only ever displayed one game at a time. Cached in the backend, so
---this is slow once per game and instant after that.
---@param payload string
---@return string
function RPC.GetGameSize(payload)
  local wrapped_func = rpcmethod(function(data)
    local size, err = sizes.get(data.app_name, data.refresh == true)
    if not size then return { ok = false, error = err } end
    return { ok = true, disk = size.disk, download = size.download }
  end)
  return wrapped_func(payload)
end

-- Installs --------------------------------------------------------------------

---Start installing, updating or resuming one game.
---
---Returns as soon as the job is spawned - the install itself runs detached, and
---its progress is read back with GetJobs. Starting a game that is already
---installing is a no-op that returns the running job.
---@param payload string
---@return string
function RPC.StartInstall(payload)
  local wrapped_func = rpcmethod(function(data)
    local job, err = jobs.install(data.app_name, data.base_path, data.game_folder)
    if not job then return { ok = false, error = err } end
    return { ok = true, job = job }
  end)
  return wrapped_func(payload)
end

---Remove a game from disk. The Steam shortcut is left alone - keeping
---uninstalled games in the library is the point of the plugin.
---@param payload string
---@return string
function RPC.StartUninstall(payload)
  local wrapped_func = rpcmethod(function(data)
    local job, err = jobs.uninstall(data.app_name)
    if not job then return { ok = false, error = err } end
    return { ok = true, job = job }
  end)
  return wrapped_func(payload)
end

---Every install or uninstall we know about, running or finished.
---
---This is what the frontend polls while something is downloading, so it stays
---cheap: the runner writes its own progress to a small file and this only reads
---it back.
---@param payload string
---@return string
function RPC.GetJobs(payload)
  local wrapped_func = rpcmethod(function()
    return { ok = true, jobs = jobs.list() }
  end)
  return wrapped_func(payload)
end

---Stop a running install, keeping what's already downloaded. legendary has no
---pause of its own, so this kills it; StartInstall is the resume.
---@param payload string
---@return string
function RPC.PauseJob(payload)
  local wrapped_func = rpcmethod(function(data)
    return { ok = jobs.pause(data.app_name) }
  end)
  return wrapped_func(payload)
end

---Stop a job and forget it. What's on disk is left where it is.
---@param payload string
---@return string
function RPC.CancelJob(payload)
  local wrapped_func = rpcmethod(function(data)
    return { ok = jobs.cancel(data.app_name) }
  end)
  return wrapped_func(payload)
end

-- Artwork ---------------------------------------------------------------------

---Move the icon Steam just wrote into the name Steam reads icons back from.
---
---The frontend hands the bytes to Steam, which saves us decoding base64 and
---writing binary from Lua; the renaming Steam leaves undone is grid.lua's job.
---@param payload string
---@return string
function RPC.PlaceIcon(payload)
  local wrapped_func = rpcmethod(function(data)
    local path, err = grid.place_icon(data.app_id, data.account_id)
    if not path then return { ok = false, error = err } end
    return { ok = true, path = path }
  end)
  return wrapped_func(payload)
end

return { RPC = RPC }
