local legendary = require("legendary")
local library = require("library")
local logger = require("logger")
local millennium = require("millennium")

-- Millennium resolves RPC method names in _G, so every method has to be a
-- global of its own. Exported by name rather than listed twice, or a method
-- added to rpc.lua and forgotten here is a frontend call that fails at runtime.
RPC = require("rpc").RPC
for name, handler in pairs(RPC) do
  _G[name] = handler
end

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
