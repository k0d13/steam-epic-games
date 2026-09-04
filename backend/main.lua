local legendary = require("legendary")
local library = require("library")
local logger = require("logger")
local millennium = require("millennium")
local shell = require("shell")
local trace = require("trace")

-- Millennium resolves RPC method names in _G, so every method has to be a
-- global. Copied by name so a method added to rpc.lua can't be forgotten here.
local RPC = require("rpc").RPC
for name, handler in pairs(RPC) do
  -- selene: allow(global_usage)
  _G[name] = handler
end

local function on_load()
  -- Written first, so the trace file says where one Steam session ends and the
  -- next begins even when the one before it stopped by crashing.
  trace.event("load")

  -- Started here so the one console window it costs goes up in the middle of
  -- Steam's own startup rather than in front of the first thing the user does.
  shell.ensure()
  trace.event("load.daemon")

  -- Cache only, so the first GetLibrary is answered from disk.
  library.load()
  trace.event("load.library")

  millennium.ready()
  trace.event("load.ready")
  logger:info("Backend loaded, waiting for frontend...")
end

local function on_frontend_loaded()
  -- Where the one-off download happens, so a machine missing legendary pays for
  -- it at startup rather than in the middle of the first thing it's asked to do.
  local status = legendary.get_status()
  logger:info(
    string.format(
      "Frontend loaded. legendary available=%s authenticated=%s",
      tostring(status.available),
      tostring(status.authenticated)
    )
  )
  trace.event("frontend", { available = status.available, authenticated = status.authenticated })
end

local function on_unload()
  trace.event("unload")
  logger:info("Backend unloaded")
end

return {
  on_load = on_load,
  on_frontend_loaded = on_frontend_loaded,
  on_unload = on_unload,
}
