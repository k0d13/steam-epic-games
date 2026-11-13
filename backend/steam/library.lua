--# selene: allow(unused_variable)
local account = require("epic.account")
local cache = require("core.cache")
local datetime = require("datetime")
local egl = require("epic.egl")
local entitlements = require("epic.entitlements")
local legendary = require("epic.legendary")
local log = require("core.log")
local paths = require("core.paths")
local proton = require("steam.proton")

-- legendary list (owned) merged with list-installed (on disk), as owned but
-- uninstalled games are the point of the plugin

local library = {}

-- Cached so a cold start can draw the library before it has spoken to Epic
local CACHE_PATH = paths.DATA .. "/cache/library.json"

---@class EpicGame
---@field app_name string Epic's internal id, and our stable key for everything
---@field title string
---@field installed boolean
---@field install_path string|nil
---@field install_size integer|nil Bytes on disk
---@field version string|nil Installed build
---@field latest_version string|nil Build the catalog is shipping
---@field folder_name string|nil Directory Epic expects the game to live in
---@field needs_update boolean
---@field art_portrait string|nil Tall box art URL
---@field art_hero string|nil Wide art URL
---@field purchased_at integer|nil Unix seconds the account was granted the game
---@field cloud_saves boolean Whether Epic keeps the game's saves
---@field dlcs EpicDlc[] The DLC the account owns for this game

---@class EpicDlc
---@field app_name string
---@field title string
---@field installed boolean
---@field install_size integer|nil Bytes on disk
---@field purchased_at integer|nil Unix seconds the account was granted it

---@class Library
---@field games EpicGame[]
---@field refreshed_at integer Unix seconds of the last read from Epic, 0 if never
---@field refreshing boolean A refresh is waiting or running
---@field error string|nil Why the last refresh asked for didn't happen

---@type EpicGame[]
local games = {}
local refreshed_at = 0

-- No --check-updates: it costs a round trip and puts nothing in the JSON, so updates
-- are compared against the catalog's build version instead
local LIST_INSTALLED = { "list-installed", "--json" }

-- Older store pages have different image types, so the first one present wins
local ART_TYPES = {
  portrait = { "DieselGameBoxTall", "OfferImageTall", "Thumbnail" },
  hero = { "DieselGameBox", "OfferImageWide", "DieselGameBoxWide" },
}

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

---latest_version stays on the game so this can be redone after an install without the catalog
---@param game table An EpicGame missing its installed fields
---@param installed_by_name table<string, table> From list-installed
---@param latest_version string|nil The catalog's build, game.latest_version if nil
---@return EpicGame
local function apply_installed(game, installed_by_name, latest_version)
  local local_game = installed_by_name[game.app_name]
  game.installed = local_game ~= nil
  game.install_path = local_game and local_game.install_path or nil
  game.install_size = local_game and local_game.install_size or nil
  game.version = local_game and local_game.version or nil
  game.latest_version = latest_version or game.latest_version

  -- A missing catalog version would otherwise flag every installed game as stale
  game.needs_update = game.installed
    and game.latest_version ~= nil
    and game.version ~= nil
    and game.version ~= game.latest_version

  for _, dlc in ipairs(game.dlcs or {}) do
    local local_dlc = installed_by_name[dlc.app_name]
    dlc.installed = local_dlc ~= nil
    dlc.install_size = local_dlc and local_dlc.install_size or nil
  end

  return game
end

-- Windows is the only platform we install
local function windows_asset(entry)
  local asset = (entry.asset_infos or {}).Windows
  return type(asset) == "table" and asset or {}
end

---Not an engine component, plugin or asset pack
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

---Legendary lists a game's DLC it owns, and some have no Windows build of their own
---because the base game includes them
---@param entry table One element of legendary list
---@param granted table<string, integer> Grant dates by catalog item
---@return EpicDlc[]
local function owned_dlcs(entry, granted)
  local dlcs = {}
  for _, dlc in ipairs(entry.dlcs or {}) do
    if type(windows_asset(dlc).build_version) == "string" then
      table.insert(dlcs, {
        app_name = dlc.app_name,
        title = dlc.app_title or dlc.app_name,
        installed = false,
        purchased_at = granted[(dlc.metadata or {}).id or ""],
      })
    end
  end
  return dlcs
end

---@param entry table One element of legendary list
---@param installed_by_name table<string, table> From list-installed
---@param granted table<string, integer> Grant dates by namespace
---@param granted_items table<string, integer> Grant dates by catalog item
---@return EpicGame
local function merge_game(entry, installed_by_name, granted, granted_items)
  local metadata = entry.metadata or {}
  local build_version = windows_asset(entry).build_version

  local game = {
    app_name = entry.app_name,
    title = entry.app_title or metadata.title or entry.app_name,
    -- legendary's default folder name, so the install dialog can show the full path
    folder_name = ((metadata.customAttributes or {}).FolderName or {}).value,
    art_portrait = pick_art(metadata.keyImages, "portrait"),
    art_hero = pick_art(metadata.keyImages, "hero"),
    purchased_at = granted[legendary.namespace(entry) or ""],
    cloud_saves = (((metadata.customAttributes or {}).CloudSaveFolder or {}).value or "") ~= "",
    dlcs = owned_dlcs(entry, granted_items),
  }

  return apply_installed(
    game,
    installed_by_name,
    type(build_version) == "string" and build_version or nil
  )
end

local REFRESH = "library"

-- A refresh asked for and not yet started, as it waits for the account's status
---@type { force: boolean }|nil
local wanted = nil

-- Where each command's output lands in the running refresh
---@type { sync: integer|nil, signature: string|nil, list: integer, installed: integer }|nil
local layout = nil

---@type string|nil
local refresh_error = nil

---@param outputs string[]
---@param codes integer[]
---@return string|nil error
local function finish(outputs, codes)
  local current = layout
  layout = nil
  if not current then
    return "The library refresh lost track of its commands"
  end

  if current.sync and current.signature then
    egl.synced(current.signature, outputs[current.sync], codes[current.sync])
  end

  local owned, err = legendary.decode_json(outputs[current.list])
  if type(owned) ~= "table" then
    return err or "legendary returned no library"
  end

  local installed_by_name = index_installed(outputs[current.installed]) or {}
  if egl.import_skipped(owned, installed_by_name) then
    -- The list only picks the imports up once they have happened
    installed_by_name = index_installed(legendary.run(LIST_INSTALLED)) or installed_by_name
  end

  local granted = entitlements.get_granted()
  local granted_items = entitlements.get_granted("catalogItemId")

  local merged = {}
  for _, entry in ipairs(owned) do
    if is_game(entry) then
      table.insert(merged, merge_game(entry, installed_by_name, granted, granted_items))
    end
  end

  table.sort(merged, function(a, b)
    return a.title < b.title
  end)

  games = merged
  refreshed_at = datetime.unix()
  save()

  local app_names = {}
  for index, game in ipairs(games) do
    app_names[index] = game.app_name
  end
  proton.apply(app_names)

  -- legendary's list leaves megabytes of garbage, which Lua would hold for minutes
  collectgarbage()

  log.info("Refreshed library: " .. #games .. " games")
  return nil
end

---Picks up a finished refresh, and starts the one asked for once the status is known
---@param status EpicStatus
local function advance(status)
  local outputs, codes = legendary.collect(REFRESH)
  if outputs then
    refresh_error = finish(outputs, codes)
  end

  if not wanted or legendary.is_running(REFRESH) or status.pending then
    return
  end

  local force = wanted.force
  wanted = nil

  -- Signed out, legendary list fails with a Python traceback, and the library is empty anyway
  if not status.authenticated then
    return
  end

  local list_args = { "list", "--json" }
  if force then
    table.insert(list_args, "--force-refresh")
  end

  -- First, so launcher installs show up in list-installed
  local commands = {}
  local sync_args, signature = egl.sync_args()
  if sync_args then
    table.insert(commands, sync_args)
  end
  table.insert(commands, list_args)
  table.insert(commands, LIST_INSTALLED)

  local started, err = legendary.start(REFRESH, commands)
  if not started then
    refresh_error = err or "Could not start the library refresh"
    return
  end

  layout = {
    sync = sync_args and 1 or nil,
    signature = signature,
    list = #commands - 1,
    installed = #commands,
  }
end

---Only what's on disk, for after an install, as new catalog entries need a full refresh
---@return EpicGame[]|nil games
---@return string? error
function library.refresh_installed()
  local installed_by_name = index_installed(legendary.run(LIST_INSTALLED))
  if not installed_by_name then
    return nil, "legendary returned no installed games"
  end

  local count = 0
  for _, game in ipairs(games) do
    apply_installed(game, installed_by_name)
    if game.installed then
      count = count + 1
    end
  end

  -- refreshed_at means when we last asked Epic, which this didn't
  save()

  log.info("Refreshed installs: " .. count .. " on disk")
  return games
end

---@param app_name string
---@return EpicGame|nil
function library.find(app_name)
  for _, game in ipairs(games) do
    if game.app_name == app_name then
      return game
    end
  end
  return nil
end

---@ffi
---Never refreshes on its own, since a cold list takes seconds, and force also bypasses
---legendary's catalog cache to pick up new purchases. A refresh runs in the background, so
---the frontend asks again until refreshing is false
---@param refresh? boolean
---@param force? boolean
---@return Library
function GetLibrary(refresh, force)
  local status = account.status()

  if refresh then
    wanted = { force = force == true or (wanted ~= nil and wanted.force) }
    refresh_error = nil
  end

  -- The store decides who's signed in, and a signed out library is an empty one; a legendary
  -- that isn't answering keeps it
  if status.available and not status.authenticated and #games > 0 then
    games, refreshed_at = {}, 0
    save()
  end

  advance(status)
  return {
    games = games,
    refreshed_at = refreshed_at,
    refreshing = wanted ~= nil or legendary.is_running(REFRESH),
    error = refresh_error,
  }
end

---@ffi
---For after an install or uninstall
---@return Library
function GetInstalled()
  local _, err = library.refresh_installed()
  return {
    games = games,
    refreshed_at = refreshed_at,
    refreshing = legendary.is_running(REFRESH),
    error = err,
  }
end

return library
