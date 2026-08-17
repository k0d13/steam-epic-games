local json = require("json")
local legendary = require("legendary")

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

return { RPC = RPC }
