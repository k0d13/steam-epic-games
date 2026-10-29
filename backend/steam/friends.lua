--# selene: allow(unused_variable)
local api = require("epic.api")
local cache = require("core.cache")
local datetime = require("datetime")
local entitlements = require("epic.entitlements")
local friends = require("epic.friends")
local json = require("json")
local log = require("core.log")
local paths = require("core.paths")

-- Which friends have played a game and what they've unlocked. Epic's store shows a
-- friend's achievements on their profile, which is a different query from the one
-- legendary asks for our own: it takes the game's product id, where a sandbox gets
-- nothing back for another account

local GRAPHQL_URL = "https://launcher.store.epicgames.com/graphql"
local GRAPHQL_HEADERS = {
  ["User-Agent"] = "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live",
}

-- One alias per friend in a query
local PROFILES_PER_CALL = 20

---@class FriendUnlock
---@field id string Epic's achievement name, as GetAchievements has it
---@field unlocked_at integer Unix seconds

---@class FriendUnlocks
---@field id string Epic account id
---@field name string Display name
---@field color string|nil Hex of the avatar Epic draws for them, like "D8033C"
---@field unlocks FriendUnlock[]

---@class FriendAchievements
---@field fetched_at integer Unix seconds
---@field product_id string|nil Nil for a game without Epic achievements
---@field friends FriendUnlocks[] Friends who have a record in the game, even with nothing unlocked

local store = cache.open(paths.DATA .. "/cache/friend-achievements.json", "friend achievements")

---A page's null is a userdata, which errors when indexed
---@param value any
---@return table
local function object(value)
  return type(value) == "table" and value or {}
end

---@param query string
---@param variables table
---@return table|nil decoded
local function graphql(query, variables)
  return api.json(GRAPHQL_URL, {
    method = "POST",
    data = json.encode({ query = query, variables = variables }),
    headers = GRAPHQL_HEADERS,
  })
end

---The game's sandbox, from the catalog entry legendary keeps
---@param app_name string
---@return string|nil
local function sandbox_of(app_name)
  local path = paths.legendary_config() .. "/metadata/" .. app_name .. ".json"
  local entry = cache.read(path, "metadata")
  if not entry then
    return nil
  end

  local from_metadata = object(entry.metadata).namespace
  if type(from_metadata) == "string" then
    return from_metadata
  end
  local from_asset = object(object(entry.asset_infos).Windows).namespace
  return type(from_asset) == "string" and from_asset or nil
end

---@param sandbox string
---@return string|nil product_id Nil if Epic couldn't be asked, or the game has no achievements
---@return boolean asked
local function product_of(sandbox)
  local decoded = graphql(
    "query($s:String!){Achievement{productAchievementsRecordBySandbox(sandboxId:$s){productId}}}",
    { s = sandbox }
  )
  if not decoded then
    return nil, false
  end

  local record = object(object(decoded.data).Achievement).productAchievementsRecordBySandbox
  local id = object(record).productId
  return type(id) == "string" and id or nil, true
end

---@param batch EpicFriend[]
---@param sandbox string
---@param product string
---@param out FriendUnlocks[]
---@return boolean asked
local function collect_unlocks(batch, sandbox, product, out)
  local declarations, fields = { "$p:String!" }, {}
  local variables = { p = product }

  for index, friend in ipairs(batch) do
    local variable = "a" .. index
    variables[variable] = friend.id
    table.insert(declarations, "$" .. variable .. ":String!")
    table.insert(
      fields,
      "f"
        .. index
        .. ":playerProfile(epicAccountId:$"
        .. variable
        .. "){avatar{small}"
        .. "achievementsSummaries{...on PlayerAchievementResponseSuccess{data{sandboxId}}}"
        .. "productAchievements(productId:$p){...on PlayerProductAchievementsResponseSuccess"
        .. "{data{playerAchievements{playerAchievement{achievementName unlocked unlockDate}}}}}}"
    )
  end

  local decoded = graphql(
    "query("
      .. table.concat(declarations, ",")
      .. "){PlayerProfile{"
      .. table.concat(fields, " ")
      .. "}}",
    variables
  )
  if not decoded then
    return false
  end

  -- A profile Epic won't show comes back null with an error against its alias
  local profiles = object(object(decoded.data).PlayerProfile)
  for index, friend in ipairs(batch) do
    local unlocks = {}
    local profile = object(profiles["f" .. index])
    local shown = object(object(profile.productAchievements).data)

    for _, entry in ipairs(object(shown.playerAchievements)) do
      local achievement = object(object(entry).playerAchievement)
      local at = entitlements.parse_date(achievement.unlockDate)
      if achievement.unlocked == true and type(achievement.achievementName) == "string" and at then
        table.insert(unlocks, { id = achievement.achievementName, unlocked_at = at })
      end
    end

    -- A record without unlocks still means they've played it
    local played = #unlocks > 0
    for _, summary in ipairs(object(object(profile.achievementsSummaries).data)) do
      played = played or object(summary).sandboxId == sandbox
    end

    if played then
      -- The color is Epic's own pick, which only comes inside the avatar's address
      local color = tostring(object(profile.avatar).small):match("/epic%-profile%-icon/(%x+)/")
      table.insert(out, { id = friend.id, name = friend.name, color = color, unlocks = unlocks })
    end
  end
  return true
end

---@ffi
---Friends who've played a game and what they've unlocked, from Epic. Friends whose
---profile Epic won't show us are left out
---@param app_name string
---@param refresh? boolean Ask Epic again even if it's cached
---@return FriendAchievements|nil
function GetFriendAchievements(app_name, refresh)
  if not api.account_id() then
    return nil
  end

  local cached = store.get()
  if cached[app_name] and not refresh then
    return cached[app_name]
  end

  local sandbox = sandbox_of(app_name)
  if not sandbox then
    return nil
  end

  -- Kept from the last time, as it never changes
  local product = (cached[app_name] or {}).product_id
  if not product then
    local asked
    product, asked = product_of(sandbox)
    if not asked then
      return nil
    end
  end

  local result = { fetched_at = datetime.unix(), product_id = product, friends = {} }
  if product then
    local list = friends.list()
    for first = 1, #list, PROFILES_PER_CALL do
      local batch = {}
      for index = first, math.min(first + PROFILES_PER_CALL - 1, #list) do
        table.insert(batch, list[index])
      end
      if not collect_unlocks(batch, sandbox, product, result.friends) then
        return nil
      end
    end
  end

  cached[app_name] = result
  store.save()

  log.info(
    "Read friends' achievements for " .. app_name .. ": " .. #result.friends .. " who have played"
  )
  return result
end
