local fs = require("fs")
local json = require("json")
local logger = require("logger")
local utils = require("utils")

-- Games installed by the Epic Games Launcher are invisible to legendary until
-- registered with it, and `egl-sync` skips any manifest it can't fully resolve -
-- base games with an empty MainGameAppName, or a missing .egstore/*.manifest -
-- reporting "Nothing to import" with no hint that anything was passed over.
--
-- EGL's manifests are plain JSON in a fixed place, so the leftovers can be read
-- here and handed to `legendary import`, which re-downloads the manifest from
-- Epic when the local one is unusable.

local egl = {}

---@class EglManifest
---@field app_name string Epic's app id, the same key legendary uses
---@field title string
---@field install_path string

---The arguments that register every EGL install legendary can resolve itself.
---
---`--import-only` matters: a full sync also *exports* legendary's installs back
---into EGL, which is not something to do to another launcher behind someone's
---back. `--one-shot` keeps it from asking to make that permanent, since there's
---no stdin to answer with, and `-y` - global, so it goes before the subcommand -
---accepts the per-game import prompts.
---@return string[] args
function egl.sync_args()
  return { "-y", "egl-sync", "--import-only", "--one-shot" }
end

---The arguments that register one EGL install with legendary. `--skip-dlcs`
---because the alternative is a prompt with no stdin to answer it, and DLC
---follows the base game once that's imported anyway.
---@param app_name string
---@param install_path string
---@return string[] args
function egl.import_args(app_name, install_path)
  return { "-y", "import", "--skip-dlcs", app_name, install_path }
end

---Where the Epic Games Launcher keeps one .item file per installed game.
---@return string
function egl.manifests_path()
  -- Always on the system drive, but not always C: - PROGRAMDATA is the only
  -- reliable way to find it.
  local program_data = utils.getenv("PROGRAMDATA")
  if not program_data or program_data == "" then program_data = "C:/ProgramData" end

  return program_data .. "/Epic/EpicGamesLauncher/Data/Manifests"
end

---Every game the Epic Games Launcher currently has installed.
---@return EglManifest[]
function egl.get_manifests()
  local path = egl.manifests_path()
  if not fs.is_directory(path) then
    logger:info("No Epic Games Launcher manifests at " .. path)
    return {}
  end

  local manifests = {}
  for _, entry in ipairs(fs.list(path) or {}) do
    -- The folder also holds a `Pending` directory for in-progress installs,
    -- which is not something we want to claim is installed.
    if entry.is_file and utils.endswith(entry.name:lower(), ".item") then
      local ok, decoded = pcall(json.decode, utils.read_file(entry.path) or "")

      if not ok or type(decoded) ~= "table" then
        logger:warn("Unreadable Epic Games Launcher manifest: " .. entry.name)
      elseif decoded.bIsIncompleteInstall == true then
        logger:info("Skipping incomplete Epic Games Launcher install: " .. tostring(decoded.DisplayName))
      elseif type(decoded.AppName) == "string" and type(decoded.InstallLocation) == "string" then
        table.insert(manifests, {
          app_name = decoded.AppName,
          title = decoded.DisplayName or decoded.AppName,
          install_path = decoded.InstallLocation,
        })
      end
    end
  end

  return manifests
end

return egl
