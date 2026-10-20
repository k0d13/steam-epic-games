local fetch = require("core.fetch")

-- egdata.app tracks Epic's store and publishes what it sees. Games are filed by sandbox
-- (the catalog's namespace) and by catalog item, which are the ids legendary's catalog
-- entries carry, so nothing is matched by name

local egdata = {}

local API = "https://api.egdata.app"

---@param namespace string
---@return table|nil offer The sandbox's base game offer
---@return boolean missing egdata answered, and has no such game
function egdata.offer(namespace)
  return fetch.json(API .. "/sandboxes/" .. namespace .. "/base-game")
end

---@param offer_id string
---@return string[]|nil features Like "Controller Support", nil if egdata couldn't be asked
function egdata.features(offer_id)
  local document = fetch.json(API .. "/offers/" .. offer_id .. "/features")
  if not document then
    return nil
  end
  return type(document.features) == "table" and document.features or {}
end

---@param item_id string
---@return table[]|nil builds Each with appName, platform, labelName, lastSeenAt, downloadSizeBytes and installedSizeBytes
---@return boolean missing egdata answered, and has no such item
function egdata.builds(item_id)
  return fetch.json(API .. "/items/" .. item_id .. "/builds")
end

return egdata
