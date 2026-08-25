local fs = require("fs")
local millennium = require("millennium")

-- Steam's grid folder is where custom artwork ends up. The frontend hands Steam
-- the bytes, since Lua here can neither fetch an image nor decode base64; this
-- is the part that has to happen on disk afterwards.

local grid = {}

---Where Steam keeps the custom artwork it's been given for this user.
---
---`account_id` is the 32-bit account id, not the 64-bit SteamID: that's what
---names the userdata folder. Falls back to the only folder present, which is
---the normal case on a single-account machine.
---@param account_id integer|string|nil
---@return string|nil path
---@return string? error
function grid.path(account_id)
  local userdata = millennium.steam_path() .. "/userdata"

  ---@type string|nil
  local account = tostring(account_id or "")
  if account == "" or not fs.is_directory(userdata .. "/" .. account) then
    account = nil

    for _, entry in ipairs(fs.list(userdata) or {}) do
      -- "0" is Steam's placeholder for "no account", and with more than one we
      -- have no business guessing which is signed in.
      if entry.is_directory and entry.name ~= "0" then
        if account then
          return nil, "several Steam accounts on this machine"
        end
        account = entry.name
      end
    end
  end

  if not account then
    return nil, "no Steam userdata folder"
  end

  local path = userdata .. "/" .. account .. "/config/grid"
  fs.create_directories(path)

  return path
end

---Move the icon Steam just wrote to the name Steam actually reads it back from.
---
---SetCustomArtworkForApp writes `<grid>/<app_id>.png`, but a shortcut's icon
---comes from `<app_id>_icon.png`. Renamed rather than copied, or the stray file
---is left competing with the `<app_id>.jpg` header.
---@param app_id integer|string
---@param account_id integer|string|nil
---@return string|nil path Where the icon ended up
---@return string? error
function grid.place_icon(app_id, account_id)
  local path, err = grid.path(account_id)
  if not path then
    return nil, err
  end

  local source = path .. "/" .. tostring(app_id) .. ".png"
  local target = path .. "/" .. tostring(app_id) .. "_icon.png"

  if not fs.is_file(source) then
    return nil, "Steam did not write " .. source
  end

  -- rename won't replace an existing file on Windows.
  if fs.is_file(target) then
    fs.remove(target)
  end
  if not fs.rename(source, target) then
    return nil, "could not rename " .. source
  end

  return target
end

return grid
