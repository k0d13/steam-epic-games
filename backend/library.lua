local egl = require("egl")
local fs = require("fs")
local json = require("json")
local legendary = require("legendary")
local logger = require("logger")
local utils = require("utils")

-- The library is the merge of two legendary commands: `list`, everything the
-- account owns straight from Epic's catalog, and `list-installed`, what is
-- actually on disk. Neither alone is enough - the whole point of this plugin is
-- showing games you own but haven't installed.

local library = {}

--- Cached so a cold start can draw the library before it has spoken to Epic.
local CACHE_PATH = utils.get_backend_path() .. "/data/library.json"

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

--- Epic ships several images per title under different type names, and which
--- ones exist varies with how old the store page is. First one present wins.
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
  if not fs.is_file(CACHE_PATH) then
    logger:info("No cached library yet")
    return
  end

  local ok, decoded = pcall(json.decode, utils.read_file(CACHE_PATH) or "")
  if not ok or type(decoded) ~= "table" then
    logger:warn("Cached library is unreadable, ignoring it")
    return
  end

  games = decoded.games or {}
  refreshed_at = decoded.refreshed_at or 0
  logger:info("Loaded " .. #games .. " games from cache")
end

---Write the library to disk through a temp file, so a crash mid-write can't
---leave a truncated cache behind for the next boot to fail on.
local function save()
  fs.create_directories(fs.parent_path(CACHE_PATH))

  local temp_path = CACHE_PATH .. ".tmp"
  local ok, err = utils.write_file(temp_path, json.encode({
    games = games,
    refreshed_at = refreshed_at,
  }))

  if not ok then
    logger:error("Could not write the library cache: " .. tostring(err))
    return
  end

  -- rename() won't replace an existing file on Windows. Losing the cache in the
  -- window between the two is survivable; the next refresh rebuilds it.
  if fs.is_file(CACHE_PATH) then fs.remove(CACHE_PATH) end
  if not fs.rename(temp_path, CACHE_PATH) then logger:error("Could not replace the library cache") end
end

-- Refresh ---------------------------------------------------------------------

---Register any Epic Games Launcher install that `egl-sync` left behind - it
---silently skips manifests it can't fully resolve, see egl.lua - and return the
---installed-game index with those folded in. Normally does nothing at all.
---@param owned table[] Decoded `legendary list` output
---@param installed_by_name table<string, table> app_name -> installed game
---@return table<string, table> installed_by_name
local function import_leftover_egl_installs(owned, installed_by_name)
  -- A manifest for something the account doesn't own is a game on somebody
  -- else's, and asking legendary to import it just fails.
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

  -- Re-reading the installed list is what picks the imports up, and it rides in
  -- the same batch rather than costing a second terminal flash.
  table.insert(commands, { "list-installed", "--check-updates", "--json" })

  local outputs = legendary.run_batch(commands)
  local installed = legendary.decode_json(outputs[#outputs])
  if type(installed) ~= "table" then return installed_by_name end

  local merged = {}
  for _, game in ipairs(installed) do
    merged[game.app_name] = game
  end
  return merged
end

---Is this catalog entry a game, rather than something Epic merely calls one?
---The catalog is full of engine components, plugins and asset packs, and nobody
---wants 200 Unreal plugins in their Steam library.
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

  return {
    app_name = entry.app_name,
    title = entry.app_title or metadata.title or entry.app_name,
    installed = local_game ~= nil,
    install_path = local_game and local_game.install_path or nil,
    install_size = local_game and local_game.install_size or nil,
    version = local_game and local_game.version or nil,
    -- What legendary names the game's directory when it's given no
    -- --game-folder, so the install dialog can show the full path up front.
    folder_name = ((metadata.customAttributes or {}).FolderName or {}).value,
    -- legendary has reported this under both names across versions, and
    -- guessing wrong silently means updates never surface.
    needs_update = local_game ~= nil
      and (local_game.needs_update == true or local_game.update_available == true),
    art_portrait = pick_art(metadata.keyImages, "portrait"),
    art_hero = pick_art(metadata.keyImages, "hero"),
  }
end

---Ask legendary for the whole library and rebuild from it.
---@param force boolean|nil Bypass legendary's own catalog cache
---@return EpicGame[]|nil games
---@return string? error
function library.refresh(force)
  -- Otherwise a broken install surfaces as empty output, and reads as an empty
  -- library rather than as itself.
  if not legendary.get_binary() then return nil, "legendary binary not found" end

  local list_args = { "list", "--json" }
  if force then table.insert(list_args, "--force-refresh") end

  -- One batch, one terminal flash. The EGL sync goes first because it's what
  -- makes Epic Games Launcher installs visible to the list-installed after it.
  -- Its failure is only logged: not having EGL is the normal case.
  local outputs = legendary.run_batch({
    egl.sync_args(),
    list_args,
    { "list-installed", "--check-updates", "--json" },
  })

  logger:info("Epic Games Launcher sync: " .. utils.trim(outputs[1]))

  local owned, err = legendary.decode_json(outputs[2])
  if type(owned) ~= "table" then return nil, err or "legendary returned no library" end

  -- Indexed so the merge below stays linear rather than a nested scan over 300+
  -- titles.
  local installed_by_name = {}
  local installed = legendary.decode_json(outputs[3])
  if type(installed) == "table" then
    for _, game in ipairs(installed) do
      installed_by_name[game.app_name] = game
    end
  end

  installed_by_name = import_leftover_egl_installs(owned, installed_by_name)

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

---Re-read only what's on disk, leaving the catalog alone.
---
---This is the after-an-install refresh. `list-installed` is local - no Epic
---round trip, no `--force-refresh`, a fraction of a full refresh - and an
---install can only ever change the installed half of a game we already know
---about. A game the catalog has never seen can't appear this way, which is
---correct: buying a game is what `library.refresh` is for.
---@return EpicGame[]|nil games
---@return string? error
function library.refresh_installed()
  if not legendary.get_binary() then return nil, "legendary binary not found" end

  local output = legendary.run({ "list-installed", "--check-updates", "--json" })
  local installed, err = legendary.decode_json(output)
  if type(installed) ~= "table" then return nil, err or "legendary returned no installed games" end

  local installed_by_name = {}
  for _, game in ipairs(installed) do
    installed_by_name[game.app_name] = game
  end

  for _, game in ipairs(games) do
    local local_game = installed_by_name[game.app_name]
    game.installed = local_game ~= nil
    game.install_path = local_game and local_game.install_path or nil
    game.install_size = local_game and local_game.install_size or nil
    game.version = local_game and local_game.version or nil
    game.needs_update = local_game ~= nil
      and (local_game.needs_update == true or local_game.update_available == true)
  end

  -- refreshed_at is left where it was on purpose: it means "when did we last
  -- ask Epic", which this didn't.
  save()

  logger:info("Refreshed installs: " .. #installed .. " on disk")
  return games
end

---The library as we last saw it, which is empty until something refreshes it.
---
---Deliberately never refreshes on its own: this is what answers the frontend's
---first call, at Steam startup, and a cold `legendary list` there would hold the
---plugin behind a network round trip to Epic and a terminal flash nobody asked
---for.
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
