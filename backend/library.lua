--# selene: allow(unused_variable)
local cache = require("cache")
local datetime = require("datetime")
local egl = require("egl")
local entitlements = require("entitlements")
local legendary = require("legendary")
local log = require("log")
local paths = require("paths")

-- `legendary list` (owned) merged with `list-installed` (on disk): owned but
-- uninstalled games are the point of the plugin.

local library = {}

--- Cached so a cold start can draw the library before it has spoken to Epic.
local CACHE_PATH = paths.DATA .. "/cache/library.json"

---@class EpicGame
---@field app_name string Epic's internal id, and our stable key for everything
---@field title string Display name
---@field installed boolean
---@field install_path string|nil
---@field install_size integer|nil Bytes on disk
---@field version string|nil Installed build version
---@field latest_version string|nil Build version the catalog is shipping
---@field folder_name string|nil Directory Epic expects the game to live in
---@field needs_update boolean
---@field art_portrait string|nil Tall box art URL
---@field art_hero string|nil Wide art URL
---@field purchased_at integer|nil Unix seconds the account was granted the game

---@class Library
---@field games EpicGame[]
---@field refreshed_at integer Unix seconds of the last read from Epic, 0 if never
---@field error string|nil Why the refresh asked for didn't happen

---@type EpicGame[]
local games = {}

--- Unix seconds of the last successful refresh.
local refreshed_at = 0

--- Older store pages have different image types, so the first one present wins.
local ART_TYPES = {
  portrait = { "DieselGameBoxTall", "OfferImageTall", "Thumbnail" },
  hero = { "DieselGameBox", "OfferImageWide", "DieselGameBoxWide" },
}

---Pick the best available image URL of one kind out of Epic's metadata.
---@param key_images table[]|nil
---@param kind "portrait"|"hero"
---@return string|nil url
local function pick_art(key_images, kind)
  if type(key_images) ~= "table" then
    return nil
  end

  for _, wanted in ipairs(ART_TYPES[kind]) do
    for _, image in ipairs(key_images) do
      if image.type == wanted and type(image.url) == "string" then
        return image.url
      end
    end
  end

  return nil
end

---Read the cached library from disk, if there is one.
function library.load()
  local decoded = cache.read(CACHE_PATH, "library")
  if not decoded then
    log.info("No cached library yet")
    return
  end

  games = decoded.games or {}
  refreshed_at = decoded.refreshed_at or 0
  log.info("Loaded " .. #games .. " games from cache")
end

local function save()
  cache.write(CACHE_PATH, { games = games, refreshed_at = refreshed_at }, "library")
end

--- No `--check-updates`: it costs a round trip and puts nothing in the JSON, so
--- updates are compared against the catalog's build version instead.
local LIST_INSTALLED = { "list-installed", "--json" }

---Index `list-installed` output by app name so merging stays linear.
---@param output string
---@return table<string, table>|nil installed_by_name
local function index_installed(output)
  local installed = legendary.decode_json(output)
  if type(installed) ~= "table" then
    return nil
  end

  local by_name = {}
  for _, game in ipairs(installed) do
    by_name[game.app_name] = game
  end
  return by_name
end

---Copy the installed fields across from `list-installed`. `latest_version` stays
---on the game so this can be redone after an install without the catalog.
---@param game table An EpicGame missing its installed fields
---@param local_game table|nil
---@param latest_version string|nil The catalog's build version, `game.latest_version` if nil
---@return EpicGame game
local function apply_installed(game, local_game, latest_version)
  game.installed = local_game ~= nil
  game.install_path = local_game and local_game.install_path or nil
  game.install_size = local_game and local_game.install_size or nil
  game.version = local_game and local_game.version or nil
  game.latest_version = latest_version or game.latest_version

  -- A missing catalog version would otherwise flag every installed game as stale.
  game.needs_update = game.installed
    and game.latest_version ~= nil
    and game.version ~= nil
    and game.version ~= game.latest_version

  return game
end

---Is this catalog entry a game, not an engine component, plugin or asset pack?
---@param entry table
---@return boolean
local function is_game(entry)
  if entry.is_dlc then
    return false
  end

  for _, category in ipairs((entry.metadata or {}).categories or {}) do
    if category.path == "games" then
      return true
    end
  end

  return false
end

---The build Epic currently ships for Windows, the only platform we install.
---@param entry table One element of `legendary list`
---@return string|nil version
local function latest_version(entry)
  local windows = (entry.asset_infos or {}).Windows
  if type(windows) ~= "table" or type(windows.build_version) ~= "string" then
    return nil
  end
  return windows.build_version
end

---The namespace entitlements are keyed by: on the entry for most titles, on the
---Windows asset for the rest.
---@param entry table One element of `legendary list`
---@return string|nil namespace
local function namespace(entry)
  local from_metadata = (entry.metadata or {}).namespace
  if type(from_metadata) == "string" then
    return from_metadata
  end

  local windows = (entry.asset_infos or {}).Windows
  return type(windows) == "table" and windows.namespace or nil
end

---Merge a catalog entry with its install, if any.
---@param entry table One element of `legendary list`
---@param local_game table|nil The matching element of `legendary list-installed`
---@param granted table<string, integer> Grant dates by namespace, per entitlements.lua
---@return EpicGame
local function merge_game(entry, local_game, granted)
  local metadata = entry.metadata or {}

  local game = {
    app_name = entry.app_name,
    title = entry.app_title or metadata.title or entry.app_name,
    -- legendary's default folder name, so the install dialog can show the full path.
    folder_name = ((metadata.customAttributes or {}).FolderName or {}).value,
    art_portrait = pick_art(metadata.keyImages, "portrait"),
    art_hero = pick_art(metadata.keyImages, "hero"),
    purchased_at = granted[namespace(entry) or ""],
  }

  return apply_installed(game, local_game, latest_version(entry))
end

---Ask legendary for the whole library and rebuild from it.
---@param force boolean|nil Bypass legendary's own catalog cache
---@return EpicGame[]|nil games
---@return string? error
function library.refresh(force)
  -- Without this a missing binary reads as an empty library.
  local binary, binary_error = legendary.get_binary()
  if not binary then
    return nil, binary_error
  end

  -- Signed out, `legendary list` fails with a Python traceback, so don't ask.
  local status = legendary.get_status()
  if not status.authenticated then
    return nil, "Not signed in to Epic."
  end

  local list_args = { "list", "--json" }
  if force then
    table.insert(list_args, "--force-refresh")
  end

  -- First, so launcher installs show up in list-installed.
  egl.sync()

  local owned, err = legendary.decode_json(legendary.run(list_args))
  if type(owned) ~= "table" then
    return nil, err or "legendary returned no library"
  end

  local installed_by_name = index_installed(legendary.run(LIST_INSTALLED)) or {}
  if egl.import_skipped(owned, installed_by_name) then
    -- The list only picks the imports up once they have happened.
    installed_by_name = index_installed(legendary.run(LIST_INSTALLED)) or installed_by_name
  end

  local granted = entitlements.get_granted()

  local merged = {}
  for _, entry in ipairs(owned) do
    if is_game(entry) then
      table.insert(merged, merge_game(entry, installed_by_name[entry.app_name], granted))
    end
  end

  table.sort(merged, function(a, b)
    return a.title < b.title
  end)

  games = merged
  refreshed_at = datetime.unix()
  save()

  log.info("Refreshed library: " .. #games .. " games")
  return games
end

---Re-read only what's on disk, for after an install. New catalog entries need
---`library.refresh`.
---@return EpicGame[]|nil games
---@return string? error
function library.refresh_installed()
  local installed_by_name = index_installed(legendary.run(LIST_INSTALLED))
  if not installed_by_name then
    return nil, "legendary returned no installed games"
  end

  local count = 0
  for _, game in ipairs(games) do
    apply_installed(game, installed_by_name[game.app_name])
    if game.installed then
      count = count + 1
    end
  end

  -- refreshed_at means "when did we last ask Epic", which this didn't.
  save()

  log.info("Refreshed installs: " .. count .. " on disk")
  return games
end

---@ffi
---The cached library. `force` also bypasses legendary's catalog cache to pick up
---new purchases. Never refreshes on its own, since a cold `list` takes seconds.
---@param refresh? boolean
---@param force? boolean
---@return Library
function GetLibrary(refresh, force)
  -- The store decides who's signed in; a signed out library is an empty one.
  if not legendary.get_status().authenticated then
    if #games > 0 then
      games, refreshed_at = {}, 0
      save()
    end
    return { games = games, refreshed_at = refreshed_at }
  end

  local err
  if refresh then
    local _
    _, err = library.refresh(force == true)
  end
  return { games = games, refreshed_at = refreshed_at, error = err }
end

---@ffi
---Re-read only what's installed, without asking Epic. For after an install or uninstall.
---@return Library
function GetInstalled()
  local _, err = library.refresh_installed()
  return { games = games, refreshed_at = refreshed_at, error = err }
end

return library
