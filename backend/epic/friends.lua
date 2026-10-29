local api = require("epic.api")
local cache = require("core.cache")
local datetime = require("datetime")
local paths = require("core.paths")

-- The signed in account's Epic friends, by their display names

local FRIENDS_URL = "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1/"
local ACCOUNTS_URL =
  "https://account-public-service-prod.ol.epicgames.com/account/api/public/account"

local MAX_AGE = 60 * 60

-- The most account ids the accounts endpoint takes at once
local ACCOUNTS_PER_CALL = 100

---@class EpicFriend
---@field id string Epic account id
---@field name string Display name, not the alias the user gave them

local friends = {}

local store = cache.open(paths.DATA .. "/cache/friends.json", "friends")

---@param ids string[]
---@return table<string, string>|nil names By account id, nil if Epic couldn't be asked
local function display_names(ids)
  local names = {}
  for first = 1, #ids, ACCOUNTS_PER_CALL do
    local query = {}
    for index = first, math.min(first + ACCOUNTS_PER_CALL - 1, #ids) do
      table.insert(query, "accountId=" .. ids[index])
    end

    local accounts = api.json(ACCOUNTS_URL .. "?" .. table.concat(query, "&"))
    if not accounts then
      return nil
    end
    for _, entry in ipairs(accounts) do
      if type(entry.id) == "string" and type(entry.displayName) == "string" then
        names[entry.id] = entry.displayName
      end
    end
  end
  return names
end

---@return EpicFriend[]|nil
local function load()
  local account_id = api.account_id()
  local listed = account_id and api.json(FRIENDS_URL .. account_id .. "/friends")
  if not listed then
    return nil
  end

  local ids = {}
  for _, entry in ipairs(listed) do
    if type(entry.accountId) == "string" then
      table.insert(ids, entry.accountId)
    end
  end

  local names = display_names(ids)
  if not names then
    return nil
  end

  local list = {}
  for _, id in ipairs(ids) do
    if names[id] then
      table.insert(list, { id = id, name = names[id] })
    end
  end
  return list
end

---Cached for an hour, and the last list stands in while Epic can't be asked
---@return EpicFriend[]
function friends.list()
  local saved = store.get()
  if saved.friends and datetime.unix() - saved.fetched_at < MAX_AGE then
    return saved.friends
  end

  local list = load()
  if not list then
    return saved.friends or {}
  end

  saved.fetched_at = datetime.unix()
  saved.friends = list
  store.save()
  return list
end

return friends
