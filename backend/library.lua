local cache = require("cache")
local egl = require("egl")
local legendary = require("legendary")
local logger = require("logger")
local utils = require("utils")

-- The merge of two legendary commands: `list`, everything the account owns, and
-- `list-installed`, what is on disk. Neither alone is enough - showing games you
-- own but haven't installed is the point of the plugin.

local library = {}

--- Cached so a cold start can draw the library before it has spoken to Epic.
local CACHE_PATH = utils.get_backend_path() .. "/data/cache/library.json"

---@class EpicGame
---@field app_name string Epic's internal id, and our stable key for everything
---@field title string Display name
---@field installed boolean
---@field install_path string|nil
---@field install_size integer|nil Bytes on disk
---@field version string|nil Installed build version
---@field folder_name string|nil Directory Epic expects the game to live in
---@field needs_update boolean
---@field art_portrait string|nil Tall box art URL
---@field art_hero string|nil Wide art URL

---@type EpicGame[]
local games = {}

--- Unix seconds of the last successful refresh.
local refreshed_at = 0

-- Artwork ---------------------------------------------------------------------

--- Which image types a title has varies with how old its store page is, so the
--- first one present wins.
local ART_TYPES = {
  portrait = { "DieselGameBoxTall", "OfferImageTall", "Thumbnail" },
  hero = { "DieselGameBox", "OfferImageWide", "DieselGameBoxWide" },
}

---Pick the best available image URL of one kind out of Epic's metadata.
---@param key_images table[]|nil
---@param kind "portrait"|"hero"
---@return string|nil url
local function pick_art(key_images, kind)
  if type(key_images) ~= "table" then return nil end

  for _, wanted in ipairs(ART_TYPES[kind]) do
    for _, image in ipairs(key_images) do
      if image.type == wanted and type(image.url) == "string" then return image.url end
    end
  end

  return nil
end

-- Persistence -----------------------------------------------------------------

---Read the cached library from disk, if there is one.
function library.load()
  local decoded = cache.read(CACHE_PATH, "library")
  if not decoded then
    logger:info("No cached library yet")
    return
  end

  games = decoded.games or {}
  refreshed_at = decoded.refreshed_at or 0
  logger:info("Loaded " .. #games .. " games from cache")
end

local function save()
  cache.write(CACHE_PATH, { games = games, refreshed_at = refreshed_at }, "library")
end

-- Refresh ---------------------------------------------------------------------

--- Reads what's on disk. Local, so no round trip to Epic.
local LIST_INSTALLED = { "list-installed", "--check-updates", "--json" }

---Index one `list-installed` output by app name, so merging stays linear rather
---than a nested scan over 300+ titles.
---@param output string
---@return table<string, table>|nil installed_by_name
local function index_installed(output)
  local installed = legendary.decode_json(output)
  if type(installed) ~= "table" then return nil end

  local by_name = {}
  for _, game in ipairs(installed) do
    by_name[game.app_name] = game
  end
  return by_name
end

---Copy the installed half of a game across from `list-installed`.
---@param game table An EpicGame missing its installed fields
---@param local_game table|nil
---@return EpicGame game
local function apply_installed(game, local_game)
  game.installed = local_game ~= nil
  game.install_path = local_game and local_game.install_path or nil
  game.install_size = local_game and local_game.install_size or nil
  game.version = local_game and local_game.version or nil
  -- legendary reports this under both names depending on its version.
  game.needs_update = local_game ~= nil
      and (local_game.needs_update == true or local_game.update_available == true)

  return game
end

---Register any Epic Games Launcher install `egl-sync` skipped (see egl.lua) and
---return the installed-game index with those folded in. Usually a no-op.
---@param owned table[] Decoded `legendary list` output
---@param installed_by_name table<string, table> app_name -> installed game
---@return table<string, table> installed_by_name
local function import_leftover_egl_installs(owned, installed_by_name)
  -- A manifest for something this account doesn't own belongs to another
  -- account, and importing it just fails.
  local owned_names = {}
  for _, game in ipairs(owned) do
    owned_names[game.app_name] = true
  end

  local commands = {}
  local titles = {}
  for _, manifest in ipairs(egl.get_manifests()) do
    if owned_names[manifest.app_name] and not installed_by_name[manifest.app_name] then
      table.insert(commands, egl.import_args(manifest.app_name, manifest.install_path))
      table.insert(titles, manifest.title)
    end
  end

  if #commands == 0 then return installed_by_name end
  logger:info("Importing Epic Games Launcher installs egl-sync skipped: " .. utils.join(titles, ", "))

  for _, args in ipairs(commands) do
    legendary.run(args)
  end

  -- Re-read: the list only picks the imports up once they have happened.
  return index_installed(legendary.run(LIST_INSTALLED)) or installed_by_name
end

---Is this catalog entry a game? The catalog is also full of engine components,
---plugins and asset packs, which nobody wants in their Steam library.
---@param entry table
---@return boolean
local function is_game(entry)
  if entry.is_dlc then return false end

  for _, category in ipairs((entry.metadata or {}).categories or {}) do
    if category.path == "games" then return true end
  end

  return false
end

---Fold one catalog entry together with what's installed on disk for it, if
---anything is.
---@param entry table One element of `legendary list`
---@param local_game table|nil The matching element of `legendary list-installed`
---@return EpicGame
local function merge_game(entry, local_game)
  local metadata = entry.metadata or {}

  local game = {
    app_name = entry.app_name,
    title = entry.app_title or metadata.title or entry.app_name,
    -- What legendary names the directory when given no --game-folder, so the
    -- install dialog can show the full path up front.
    folder_name = ((metadata.customAttributes or {}).FolderName or {}).value,
    art_portrait = pick_art(metadata.keyImages, "portrait"),
    art_hero = pick_art(metadata.keyImages, "hero"),
  }

  return apply_installed(game, local_game)
end

---Ask legendary for the whole library and rebuild from it.
---@param force boolean|nil Bypass legendary's own catalog cache
---@return EpicGame[]|nil games
---@return string? error
function library.refresh(force)
  -- Without this a missing binary reads as an empty library.
  if not legendary.get_binary() then return nil, "legendary binary not found" end

  local list_args = { "list", "--json" }
  if force then table.insert(list_args, "--force-refresh") end

  -- The EGL sync goes first: it's what makes launcher installs visible to the
  -- list-installed after it. Its failure is only logged, since not having EGL
  -- is normal.
  logger:info("Epic Games Launcher sync: " .. utils.trim(legendary.run(egl.sync_args())))

  local owned, err = legendary.decode_json(legendary.run(list_args))
  if type(owned) ~= "table" then return nil, err or "legendary returned no library" end

  local installed_by_name =
      import_leftover_egl_installs(owned, index_installed(legendary.run(LIST_INSTALLED)) or {})

  local merged = {}
  for _, entry in ipairs(owned) do
    if is_game(entry) then
      table.insert(merged, merge_game(entry, installed_by_name[entry.app_name]))
    end
  end

  table.sort(merged, function(a, b) return a.title < b.title end)

  games = merged
  refreshed_at = math.floor(utils.time())
  save()

  logger:info("Refreshed library: " .. #games .. " games")
  return games
end

---Re-read only what's on disk, leaving the catalog alone. This is the
---after-an-install refresh: a game the catalog has never seen can't appear this
---way, which is what `library.refresh` is for.
---@return EpicGame[]|nil games
---@return string? error
function library.refresh_installed()
  if not legendary.get_binary() then return nil, "legendary binary not found" end

  local installed_by_name = index_installed(legendary.run(LIST_INSTALLED))
  if not installed_by_name then return nil, "legendary returned no installed games" end

  local count = 0
  for _, game in ipairs(games) do
    apply_installed(game, installed_by_name[game.app_name])
    if game.installed then count = count + 1 end
  end

  -- refreshed_at means "when did we last ask Epic", which this didn't.
  save()

  logger:info("Refreshed installs: " .. count .. " on disk")
  return games
end

---The library as we last saw it, empty until something refreshes it. Never
---refreshes on its own: this answers the frontend's first call at startup, and
---a cold `legendary list` there would hold the plugin behind a round trip to
---Epic.
---@return EpicGame[] games
function library.get()
  return games
end

---When the library was last read from Epic, in Unix seconds. 0 if never.
---@return integer
function library.get_refreshed_at()
  return refreshed_at
end

return library
