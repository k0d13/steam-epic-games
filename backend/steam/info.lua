--# selene: allow(unused_variable)
local cache = require("core.cache")
local datetime = require("datetime")
local egdata = require("epic.egdata")
local entitlements = require("epic.entitlements")
local fetch = require("core.fetch")
local log = require("core.log")
local paths = require("core.paths")
local utils = require("utils")

-- What Steam's game info panel shows for an Epic game. egdata.app, which tracks Epic's
-- store, has a page for each game's sandbox (its namespace), so a game is matched by
-- namespace, never by name. The store's own content API is asked only whether the game
-- has an FAQ. Games egdata doesn't list keep what legendary's catalog has

---@class GameLink
---@field label string
---@field url string

---@class GameInfo
---@field description string One short paragraph, or "" if Epic has none
---@field developers string[]
---@field publishers string[]
---@field released_at integer|nil Unix seconds
---@field tags string[] egdata's tags and features, like "Single Player" or "RPG"
---@field cloud_saves boolean
---@field links GameLink[] Pages about the game on Epic's store
---@field version integer Which shape of this a saved copy has
---@field fetched_at integer Unix seconds

local CONTENT_API = "https://store-content-ipv4.ak.epicgames.com/api"
local PRODUCT_URL = CONTENT_API .. "/en-US/content/products/"
local STORE_URL = "https://store.epicgames.com/p/"

local store = cache.open(paths.DATA .. "/cache/info.json", "info")

-- A game's details are edited rarely
local INFO_MAX_AGE = 14 * 24 * 60 * 60

-- Raised when GameInfo gains something, so saved copies without it are read again
local INFO_VERSION = 6

-- Steam's panel is a few lines wide, and some catalog descriptions run to pages
local DESCRIPTION_MAX = 400

---A page's null is a userdata, which errors when indexed
---@param value any
---@return table
local function object(value)
  return type(value) == "table" and value or {}
end

---The blanks and repeats gone
---@param list any
---@param fallback any One name to use when the list has none
---@return string[]
local function names(list, fallback)
  local out, seen = {}, {}

  local function add(name)
    local trimmed = type(name) == "string" and utils.trim(name) or ""
    if trimmed ~= "" and not seen[trimmed] then
      seen[trimmed] = true
      table.insert(out, trimmed)
    end
  end

  for _, name in ipairs(object(list)) do
    add(name)
  end
  if #out == 0 then
    add(fallback)
  end

  return out
end

---@param slug string
---@return boolean|nil faq Whether the game has a page of frequently asked questions, nil if Epic couldn't be asked
local function fetch_faq(slug)
  local product, missing = fetch.json(PRODUCT_URL .. slug)
  if not product then
    return missing and false or nil
  end

  for _, page in ipairs(object(product.pages)) do
    page = object(page)
    if page.type == "info" and page._slug == "faq" then
      return true
    end
  end
  return false
end

---@param slug string
---@param faq boolean
---@return GameLink[]
local function build_links(slug, faq)
  ---@type GameLink[]
  local links = { { label = "Store Page", url = STORE_URL .. slug } }
  if faq then
    table.insert(links, { label = "FAQ", url = STORE_URL .. slug .. "--faq" })
  end
  return links
end

---The store page's slug. Most offers map to a productHome page, but some, like
---Fortnite's, only name their slug in productSlug or map to another kind of page
---@param offer table
---@return string|nil
local function page_slug(offer)
  local fallback = nil
  for _, mapping in ipairs(object(offer.offerMappings)) do
    mapping = object(mapping)
    if type(mapping.pageSlug) == "string" then
      if mapping.pageType == "productHome" then
        return mapping.pageSlug
      end
      fallback = fallback or mapping.pageSlug
    end
  end

  -- A productSlug can name a page under the product, like "game/home"
  local product = type(offer.productSlug) == "string" and offer.productSlug:match("^[^/]+") or nil
  return product or fallback
end

---One line of text, cut at a word if it's long
---@param text any
---@return string
local function tidy(text)
  if type(text) ~= "string" then
    return ""
  end

  text = utils.trim((text:gsub("%s+", " ")))
  if #text <= DESCRIPTION_MAX then
    return text
  end

  -- Cut after a space so a multi-byte character is never split
  local words = text:sub(1, DESCRIPTION_MAX + 1):match("^(.*)%s") or text:sub(1, DESCRIPTION_MAX)
  return words .. "…"
end

---From a catalog entry's customAttributes
---@param metadata table
---@param key string
---@return string|nil
local function attribute(metadata, key)
  local entry = object(object(metadata.customAttributes)[key])
  return type(entry.value) == "string" and entry.value or nil
end

---@param metadata table legendary's catalog entry for the game
---@return GameInfo info
---@return boolean complete False when egdata or Epic couldn't be asked, so this is worth retrying
local function build(metadata)
  local offer, missing = nil, false
  if type(metadata.namespace) == "string" then
    offer, missing = egdata.offer(metadata.namespace)
  end
  offer = offer or {}

  local slug = page_slug(offer)
  local complete = offer.id ~= nil or missing

  -- Tags say what the game is, features what it supports; the panel reads both the same way
  local tags = {}
  for _, tag in ipairs(object(offer.tags)) do
    table.insert(tags, object(tag).name)
  end
  if type(offer.id) == "string" then
    local features = egdata.features(offer.id)
    complete = complete and features ~= nil
    for _, feature in ipairs(features or {}) do
      table.insert(tags, feature)
    end
  end

  local faq = false
  if slug then
    local found = fetch_faq(slug)
    complete = complete and found ~= nil
    faq = found or false
  end

  local description = tidy(offer.description)
  if description == "" then
    description = tidy(metadata.description)
  end

  -- When it came to PC, over when this edition went on sale
  local released = entitlements.parse_date(offer.pcReleaseDate)
    or entitlements.parse_date(offer.releaseDate)

  ---@type GameInfo
  local info = {
    description = description,
    developers = names(
      { offer.developerDisplayName },
      attribute(metadata, "developerName")
        or attribute(metadata, "com.epicgames.app.developerName")
        or metadata.developer
    ),
    publishers = names(
      { offer.publisherDisplayName },
      attribute(metadata, "com.epicgames.app.publisherName")
    ),
    released_at = released,
    tags = names(tags),
    cloud_saves = (attribute(metadata, "CloudSaveFolder") or "") ~= "",
    links = slug and build_links(slug, faq) or {},
    version = INFO_VERSION,
    fetched_at = datetime.unix(),
  }

  return info, complete
end

---@ffi
---A miss costs a few requests to egdata and Epic, and is cached for weeks
---@param app_name string
---@param refresh? boolean Ask Epic again even if it's cached
---@return GameInfo|nil
function GetGameInfo(app_name, refresh)
  local infos = store.get()

  local cached = infos[app_name]
  if
    cached
    and not refresh
    and cached.version == INFO_VERSION
    and datetime.unix() - cached.fetched_at < INFO_MAX_AGE
  then
    return cached
  end

  -- legendary's own copy of the catalog entry
  local entry =
    cache.read(paths.legendary_config() .. "/metadata/" .. app_name .. ".json", "catalog")
  if type(entry) ~= "table" or type(entry.metadata) ~= "table" then
    log.warn("No catalog entry for " .. app_name)
    return cached
  end

  local info, complete = build(entry.metadata)
  if not complete then
    -- A stale answer from before beats a thin one from now
    return cached or info
  end

  infos[app_name] = info
  store.save()

  log.info(
    "Read info for "
      .. app_name
      .. ": "
      .. #info.developers
      .. " developers, "
      .. #info.tags
      .. " tags"
  )
  return info
end
