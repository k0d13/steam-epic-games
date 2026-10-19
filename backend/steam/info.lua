--# selene: allow(unused_variable)
local cache = require("core.cache")
local datetime = require("datetime")
local entitlements = require("epic.entitlements")
local http = require("http")
local log = require("core.log")
local paths = require("core.paths")
local utils = require("utils")

-- What Steam's game info panel shows for an Epic game. legendary's catalog cache has
-- the description and developer for every game, and the rest comes from the store's
-- content API, which needs no sign in. Its product pages are filed by slug, and Epic
-- publishes which namespace each slug belongs to, so a game is matched by namespace,
-- never by name. Games Epic doesn't list there keep what the catalog has

---@class GameLink
---@field label string
---@field url string

---@class GameInfo
---@field description string One short paragraph, or "" if Epic has none
---@field developers string[]
---@field publishers string[]
---@field released_at integer|nil Unix seconds
---@field tags string[] Epic's own, like "SINGLE_PLAYER" or "RPG"
---@field cloud_saves boolean
---@field links GameLink[] Pages about the game on Epic's store
---@field version integer Which shape of this a saved copy has
---@field fetched_at integer Unix seconds

local CONTENT_API = "https://store-content-ipv4.ak.epicgames.com/api"
local MAPPING_URL = CONTENT_API .. "/content/productmapping"
local PRODUCT_URL = CONTENT_API .. "/en-US/content/products/"
local STORE_URL = "https://store.epicgames.com/p/"

local MAPPING_PATH = paths.DATA .. "/cache/product-mapping.json"
local store = cache.open(paths.DATA .. "/cache/info.json", "info")

-- New games get a slug now and then, and a page's details are edited rarely
local MAPPING_MAX_AGE = 7 * 24 * 60 * 60
local INFO_MAX_AGE = 14 * 24 * 60 * 60

-- Raised when GameInfo gains something, so saved copies without it are read again
local INFO_VERSION = 4

-- Steam's panel is a few lines wide, and some catalog descriptions run to pages
local DESCRIPTION_MAX = 400

---A page's null is a userdata, which errors when indexed
---@param value any
---@return table
local function object(value)
  return type(value) == "table" and value or {}
end

---@param url string
---@return table|nil document
---@return boolean missing Epic answered, and it has no such page
local function fetch_json(url)
  local response, err = http.get(url, { timeout = 10 })
  if not response then
    log.warn("Could not reach " .. url .. ": " .. tostring(err))
    return nil, false
  end

  if response.status == 404 then
    return nil, true
  end

  local decoded = response.status == 200 and cache.decode(response.body) or nil
  if type(decoded) ~= "table" then
    log.warn(url .. " answered " .. response.status)
  end
  return decoded, false
end

---@type table<string, string>|nil
local slugs = nil

---@return table<string, string> slugs by namespace
---@return boolean current False when Epic couldn't be asked, so these may be missing games
local function load_slugs()
  if slugs then
    return slugs, true
  end

  local cached = cache.read(MAPPING_PATH, "product mapping")
  if cached and datetime.unix() - (cached.fetched_at or 0) < MAPPING_MAX_AGE then
    slugs = cached.slugs or {}
    return slugs, true
  end

  local fetched = fetch_json(MAPPING_URL)
  if not fetched then
    -- Offline, where an old mapping beats none, and isn't kept so the next call tries again
    return cached and cached.slugs or {}, false
  end

  slugs = fetched
  cache.write(MAPPING_PATH, { fetched_at = datetime.unix(), slugs = fetched }, "product mapping")
  return slugs, true
end

---@param slug string
---@return table|nil page The part of a product page that describes the game
---@return boolean missing
---@return boolean faq Whether the game has a page of frequently asked questions
local function fetch_page(slug)
  local product, missing = fetch_json(PRODUCT_URL .. slug)

  local home, faq = nil, false
  for _, page in ipairs(object(object(product).pages)) do
    page = object(page)
    if page.type == "productHome" and type(page.data) == "table" then
      home = page.data
    elseif page.type == "info" and page._slug == "faq" then
      faq = true
    end
  end
  return home, home == nil and missing, faq
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
---@return boolean complete False when the store couldn't be asked, so this is worth retrying
local function build(metadata)
  local slugs_by_namespace, current = load_slugs()
  local slug = slugs_by_namespace[metadata.namespace or ""]

  local page, missing, faq, meta, about = nil, false, false, {}, {}
  if slug then
    page, missing, faq = fetch_page(slug)
    meta = object(object(page).meta)
    about = object(object(page).about)
  end

  local description = tidy(about.shortDescription)
  if description == "" then
    description = tidy(metadata.description)
  end

  local released = type(meta.releaseDate) == "string" and entitlements.parse_date(meta.releaseDate)
    or nil

  ---@type GameInfo
  local info = {
    description = description,
    developers = names(
      meta.developer,
      about.developerAttribution
        or attribute(metadata, "developerName")
        or attribute(metadata, "com.epicgames.app.developerName")
        or metadata.developer
    ),
    publishers = names(
      meta.publisher,
      about.publisherAttribution or attribute(metadata, "com.epicgames.app.publisherName")
    ),
    released_at = released,
    tags = names(meta.tags),
    cloud_saves = (attribute(metadata, "CloudSaveFolder") or "") ~= "",
    links = slug and page and build_links(slug, faq) or {},
    version = INFO_VERSION,
    fetched_at = datetime.unix(),
  }

  -- No slug is an answer too, and only a mapping or a page we couldn't fetch is worth asking again
  return info, current and (slug == nil or page ~= nil or missing)
end

---@ffi
---A miss costs a request or two to Epic's store, and is cached for weeks
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
