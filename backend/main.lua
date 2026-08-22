local legendary = require("legendary")
local library = require("library")
local logger = require("logger")
local millennium = require("millennium")
local shell = require("shell")

-- Millennium resolves RPC method names in _G, so every method has to be a
-- global. Copied by name so a method added to rpc.lua can't be forgotten here.
RPC = require("rpc").RPC
for name, handler in pairs(RPC) do
  _G[name] = handler
end

local function on_load()
  -- Started here so the one console window it costs goes up in the middle of
  -- Steam's own startup rather than in front of the first thing the user does.
  shell.ensure()

  -- Cache only, so the first GetLibrary is answered from disk.
  library.load()

  millennium.ready()
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
end

local function on_unload()
  logger:info("Backend unloaded")
end

return {
  on_load = on_load,
  on_frontend_loaded = on_frontend_loaded,
  on_unload = on_unload,
}
