local grid = require("grid")
local json = require("json")
local legendary = require("legendary")
local library = require("library")

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
---@param payload string
---@return string
function RPC.GetLibrary(payload)
  local wrapped_func = rpcmethod(function(data)
    local games, err = library.get()
    if data.refresh then games, err = library.refresh(data.force == true) end

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
