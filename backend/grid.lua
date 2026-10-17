--# selene: allow(unused_variable)
local fs = require("fs")
local log = require("log")
local millennium = require("millennium")

-- The frontend hands Steam the artwork bytes, since Lua here can't fetch or decode
-- base64; this tidies the grid folder afterwards.

---This user's grid folder. `account_id` is the 32-bit id that names the userdata
---folder; without it, the only folder present is used.
---@param account_id integer|string|nil
---@return string|nil path
---@return string? error
local function grid_path(account_id)
  local userdata = millennium.steam_path() .. "/userdata"

  ---@type string|nil
  local account = tostring(account_id or "")
  if account == "" or not fs.is_directory(userdata .. "/" .. account) then
    account = nil

    for _, entry in ipairs(fs.list(userdata) or {}) do
      -- "0" means no account; with several we can't tell which is signed in.
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

---ico for SteamGridDB's icons. Not jpg: `<app_id>.jpg` is the header image.
local ICON_EXTENSIONS = { "png", "ico" }

---@ffi
---SetCustomArtworkForApp writes `<app_id>.<ext>` but shortcuts read `<app_id>_icon.<ext>`.
---Moved, not copied, or the leftover competes with the `.jpg` header.
---@param app_id integer|string
---@param account_id? integer|string
---@return string|nil path Where the icon ended up
function PlaceIcon(app_id, account_id)
  local path, err = grid_path(account_id)
  if not path then
    log.warn("Could not place the icon for " .. tostring(app_id) .. ": " .. tostring(err))
    return nil
  end

  local id = tostring(app_id)

  local source, extension
  for _, candidate in ipairs(ICON_EXTENSIONS) do
    local file = path .. "/" .. id .. "." .. candidate
    if fs.is_file(file) then
      source, extension = file, candidate
      break
    end
  end

  if not source then
    log.warn("Steam wrote no icon for " .. id .. " in " .. path)
    return nil
  end

  -- Every extension: a stale icon would win, and rename won't overwrite on Windows.
  for _, candidate in ipairs(ICON_EXTENSIONS) do
    local existing = path .. "/" .. id .. "_icon." .. candidate
    if fs.is_file(existing) then
      fs.remove(existing)
    end
  end

  local target = path .. "/" .. id .. "_icon." .. extension
  if not fs.rename(source, target) then
    log.warn("Could not rename " .. source)
    return nil
  end

  return target
end

---@ffi
---Delete every grid image of the given shortcuts: `<id>.<ext>`, `<id>p`, `<id>_hero`,
---`<id>_logo`, `<id>_icon` and the logo position `<id>.json`. Steam leaves them behind
---when a shortcut is removed.
---@param app_ids string Comma separated, since a list doesn't cross the bridge
---@param account_id? integer|string
---@return integer removed Files deleted
function RemoveArtwork(app_ids, account_id)
  local path, err = grid_path(account_id)
  if not path then
    log.warn("Could not remove artwork: " .. tostring(err))
    return 0
  end

  local wanted = {}
  for id in tostring(app_ids):gmatch("%d+") do
    wanted[id] = true
  end

  local removed = 0
  for _, entry in ipairs(fs.list(path) or {}) do
    -- The digits up to the first suffix character, so `12p.png` doesn't read as 12.
    local id = not entry.is_directory and entry.name:match("^(%d+)[p_%.]") or nil
    if id and wanted[id] and fs.remove(path .. "/" .. entry.name) then
      removed = removed + 1
    end
  end

  log.info("Removed " .. removed .. " artwork files")
  return removed
end
