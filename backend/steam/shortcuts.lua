--# selene: allow(unused_variable)
local fs = require("fs")
local legendary = require("epic.legendary")
local log = require("core.log")
local millennium = require("millennium")
local paths = require("core.paths")
local shell = require("core.shell")
local utils = require("utils")

-- What the frontend can't do for a shortcut itself: the icon file, and tidying the grid
-- folder Steam leaves behind

---@class LaunchCommand
---@field exe string
---@field arguments string

---Where Windows keeps conhost, which can run a console program without a window
local function conhost()
  local root = utils.getenv("SystemRoot")
  return shell.native_path((root ~= "" and root or "C:/Windows") .. "/System32/conhost.exe")
end

---@ffi
---legendary waits on the game for play time, follows the exe if Epic moves it and works before
---install; on Windows a headless conhost keeps its console window from opening
---@param app_name string
---@return LaunchCommand|nil
function GetLaunchCommand(app_name)
  local binary = legendary.is_app_name(app_name) and legendary.get_binary()
  if not binary then
    return nil
  end

  local launch = 'launch "' .. app_name .. '"'

  -- Steam shows the path as given, so it gets one style of separator
  if paths.IS_WINDOWS then
    return {
      exe = conhost(),
      arguments = '--headless "' .. shell.native_path(binary) .. '" ' .. launch,
    }
  end

  return { exe = binary, arguments = launch }
end

---The userdata folder is named by the 32-bit account id, and without one the only
---folder present is used
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
      -- "0" means no account, and with several we can't tell which is signed in
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

-- ico is for SteamGridDB's icons, cleared too as a stale one would win over ours
local ICON_EXTENSIONS = { "png", "ico" }

---@ffi
---Shortcuts read <app_id>_icon.<ext>; written here as Steam's SetCustomArtworkForApp
---no longer takes Icon artwork
---@param app_id integer|string
---@param account_id integer|string
---@param base64 string The PNG
---@return string|nil path Where the icon ended up
function PlaceIcon(app_id, account_id, base64)
  local path, err = grid_path(account_id)
  if not path then
    log.warn("Could not place the icon for " .. tostring(app_id) .. ": " .. tostring(err))
    return nil
  end

  local id = tostring(app_id)
  for _, candidate in ipairs(ICON_EXTENSIONS) do
    local existing = path .. "/" .. id .. "_icon." .. candidate
    if fs.is_file(existing) then
      fs.remove(existing)
    end
  end

  local png = utils.base64_decode(base64)
  local target = path .. "/" .. id .. "_icon.png"
  utils.write_file(target, png)

  -- A text mode write would turn the PNG's line endings into CRLF
  if fs.file_size(target) ~= #png then
    log.warn("Could not write the icon for " .. id .. " to " .. target)
    return nil
  end

  -- Steam shows the icon path as given, like the launch command's
  return shell.native_path(target)
end

---@ffi
---Every grid image of the shortcuts, which Steam leaves behind when one is removed:
---<id>.<ext>, <id>p, <id>_hero, <id>_logo, <id>_icon and the logo position <id>.json
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
    -- The digits up to the first suffix character, so 12p.png doesn't read as 12
    local id = not entry.is_directory and entry.name:match("^(%d+)[p_%.]") or nil
    if id and wanted[id] and fs.remove(path .. "/" .. entry.name) then
      removed = removed + 1
    end
  end

  log.info("Removed " .. removed .. " artwork files")
  return removed
end
