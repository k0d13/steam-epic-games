local fs = require("fs")
local millennium = require("millennium")

-- Steam's grid folder is where the custom artwork a client is given ends up. The
-- frontend hands Steam the bytes, since Millennium's Lua can neither fetch an
-- image nor decode base64; what's left is the part it can't do from there.

local grid = {}

---Where Steam keeps the custom artwork it's been given for this user.
---
---`account_id` is the 32-bit account id, not the 64-bit SteamID - that's what
---names the userdata folder. Checked rather than trusted, falling back to the
---only folder present, which is the normal case on a single-account machine.
---@param account_id integer|string|nil
---@return string|nil path
---@return string? error
function grid.path(account_id)
  local userdata = millennium.steam_path() .. "/userdata"

  local account = tostring(account_id or "")
  if account == "" or not fs.is_directory(userdata .. "/" .. account) then
    account = nil

    for _, entry in ipairs(fs.list(userdata) or {}) do
      -- "0" is Steam's placeholder for "no account", and more than one real
      -- account means we have no business guessing which one is signed in.
      if entry.is_directory and entry.name ~= "0" then
        if account then return nil, "several Steam accounts on this machine" end
        account = entry.name
      end
    end
  end

  if not account then return nil, "no Steam userdata folder" end

  local path = userdata .. "/" .. account .. "/config/grid"
  fs.create_directories(path)

  return path
end

---Move the icon Steam just wrote to the name Steam actually reads it back from.
---
---SetCustomArtworkForApp with the Icon asset type writes `<grid>/<app_id>.png`,
---the same stem the *header* uses, and nothing ever reads it as an icon: a
---shortcut's icon comes from a path in shortcuts.vdf named `<app_id>_icon.png`.
---Renaming rather than copying matters, or that stray `<app_id>.png` is left
---competing with the `<app_id>.jpg` header.
---@param app_id integer|string
---@param account_id integer|string|nil
---@return string|nil path Where the icon ended up
---@return string? error
function grid.place_icon(app_id, account_id)
  local path, err = grid.path(account_id)
  if not path then return nil, err end

  local source = path .. "/" .. tostring(app_id) .. ".png"
  local target = path .. "/" .. tostring(app_id) .. "_icon.png"

  if not fs.is_file(source) then return nil, "Steam did not write " .. source end

  -- rename won't replace an existing file on Windows, and there will be one
  -- every time artwork is applied a second time.
  if fs.is_file(target) then fs.remove(target) end
  if not fs.rename(source, target) then return nil, "could not rename " .. source end

  return target
end

return grid
