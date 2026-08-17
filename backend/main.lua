-- Millennium's luavm runs LuaJIT, which compiles hot loops into dynamically
-- generated executable code pages. Anti-cheat / memory-scanning software that
-- injects into every process (e.g. nProtect GameGuard, Windhawk) crashes when it
-- walks those anonymous JIT regions, surfacing as an EXCEPTION_ACCESS_VIOLATION
-- inside the injected module and getting misattributed to this plugin. Forcing
-- the interpreter removes the trigger.
if type(jit) == "table" and type(jit.off) == "function" then
  pcall(jit.off)
  pcall(jit.flush)
end

local legendary = require("legendary")
local library = require("library")
local logger = require("logger")
local millennium = require("millennium")

-- Millennium resolves RPC method names in _G, so these have to be globals.
RPC = require("rpc").RPC
GetStatus = RPC.GetStatus
SignIn = RPC.SignIn
SignOut = RPC.SignOut
GetLibrary = RPC.GetLibrary
GetLaunchCommand = RPC.GetLaunchCommand
GetGameSize = RPC.GetGameSize
PlaceIcon = RPC.PlaceIcon

local function on_load()
  -- Cache only, so the frontend's first GetLibrary is answered from disk rather
  -- than by going out to Epic. Costs nothing when there's no cache yet.
  library.load()

  millennium.ready()
  logger:info("Backend loaded, waiting for frontend...")
end

local function on_frontend_loaded()
  -- Resolve the binary now rather than on the first call, so a broken install
  -- shows up in the log at startup instead of as a button that does nothing.
  local status = legendary.get_status()
  logger:info(
    "Frontend loaded. legendary available="
      .. tostring(status.available)
      .. " authenticated="
      .. tostring(status.authenticated)
  )
end

local function on_unload()
  logger:info("Backend unloaded")
end

return {
  on_load = on_load,
  on_frontend_loaded = on_frontend_loaded,
  on_unload = on_unload,
}
