--# selene: allow(unused_variable)
local cache = require("core.cache")
local datetime = require("datetime")
local entitlements = require("epic.entitlements")
local legendary = require("epic.legendary")
local log = require("core.log")
local paths = require("core.paths")
local proton = require("steam.proton")

-- Epic's cloud saves. legendary moves them, but only ever toward whichever side has the
-- newer files, so the launcher's conflict check is ours: we note when each game last
-- synced, and saves changed since on both sides are a conflict for Steam's dialog

---@class CloudSaves
---@field app_name string
---@field status string "synced", "upload", "download", "conflict", "failed", "unavailable" or "unknown"
---@field local_at integer|nil Unix seconds the newest local save was written
---@field remote_at integer|nil Unix seconds the newest cloud save was made
---@field synced_at integer|nil Unix seconds of the last sync
---@field error string|nil

-- Outside the cache folder, as losing it would turn every game into a conflict
local record = cache.open(paths.DATA .. "/cloud.json", "cloud saves")

-- legendary counts saves this many seconds apart as the same
local SAME_AGE = 60

-- What a check can find that's worth keeping across a restart; "upload" and "download"
-- are only true until the sync that follows them, and "unavailable" is asked again
local KEPT = { synced = true, conflict = true, failed = true }

---legendary prints UTC dates as "2026-10-22 09:53:00", or N/A for a side with no saves
---@param output string
---@param side string "Local" or "Cloud"
---@return integer|nil
local function save_date(output, side)
  local value = output:match("%- " .. side .. " save date: (%d+%-%d+%-%d+ %d+:%d+:%d+)")
  return value and entitlements.parse_date((value:gsub(" ", "T"))) or nil
end

---@param app_name string
---@param result table A CloudSaves without its app_name and synced_at
---@return CloudSaves
local function finish(app_name, result)
  local data = record.get()
  local entry = data[app_name] or {}

  if KEPT[result.status] then
    entry.status = result.status
    entry.local_at = result.local_at
    entry.remote_at = result.remote_at
    entry.error = result.error
    if result.status == "synced" then
      entry.synced_at = datetime.unix()
    end
    data[app_name] = entry
    record.save()
  end

  result.app_name = app_name
  result.synced_at = entry.synced_at
  return result
end

---@ffi
---Compares a game's saves with Epic's cloud, moving nothing: legendary's sync with both
---directions skipped only reports, and sets the save path the first time
---@param app_name string
---@return CloudSaves
function CheckSaves(app_name)
  if not legendary.is_app_name(app_name) then
    return { app_name = app_name, status = "unavailable" }
  end

  -- Before Proton has made the prefix, legendary would work out a path in ~/.wine and
  -- keep it; there's nothing to sync yet either, so the check after the game exits counts
  if not paths.IS_WINDOWS and not proton.has_prefix(app_name) then
    return finish(app_name, { status = "unknown" })
  end

  local output, status = legendary.run({
    "-y",
    "sync-saves",
    app_name,
    "--accept-path",
    "--skip-upload",
    "--skip-download",
  })
  if status ~= 0 then
    local err = legendary.last_error(output) or ("legendary exited " .. status)
    log.warn("Could not check the saves of " .. app_name .. ": " .. err)
    return finish(app_name, { status = "failed", error = err })
  end

  -- Skipped without a word when Epic keeps no saves for it, or its path can't be worked out
  if not output:find('Checking "', 1, true) or output:find("unprocessed variables", 1, true) then
    return finish(app_name, { status = "unavailable" })
  end
  if
    output:find("is up to date", 1, true) or output:find("No cloud or local savegame", 1, true)
  then
    return finish(app_name, { status = "synced" })
  end

  local local_at, remote_at = save_date(output, "Local"), save_date(output, "Cloud")
  local synced_at = (record.get()[app_name] or {}).synced_at

  -- Never synced here, so whatever a side has is news
  local local_changed = local_at ~= nil and (not synced_at or local_at > synced_at + SAME_AGE)
  local remote_changed = remote_at ~= nil and (not synced_at or remote_at > synced_at + SAME_AGE)

  local result = { local_at = local_at, remote_at = remote_at }
  if local_changed and remote_changed then
    result.status = "conflict"
  elseif local_changed then
    result.status = "upload"
  elseif remote_changed then
    result.status = "download"
  else
    -- A download leaves the files newer than the cloud's, which isn't a change to send back
    result.status = "synced"
  end
  return finish(app_name, result)
end

---@ffi
---Moves a game's saves one way, whichever side is newer, as a check decided or the
---user picked in a conflict
---@param app_name string
---@param direction string "upload" or "download"
---@return CloudSaves
function SyncSaves(app_name, direction)
  if not legendary.is_app_name(app_name) or (direction ~= "upload" and direction ~= "download") then
    return { app_name = app_name, status = "failed", error = "Nothing to sync" }
  end

  local output, status = legendary.run({
    "-y",
    "sync-saves",
    app_name,
    "--accept-path",
    direction == "upload" and "--force-upload" or "--force-download",
  })

  -- A failed chunk is logged as an error but still exits 0
  local err = legendary.last_error(output)
  if status ~= 0 or err then
    err = err or ("legendary exited " .. status)
    log.warn("Could not " .. direction .. " the saves of " .. app_name .. ": " .. err)
    return finish(app_name, { status = "failed", error = err })
  end

  log.info((direction == "upload" and "Uploaded" or "Downloaded") .. " the saves of " .. app_name)
  return finish(app_name, { status = "synced" })
end

---@ffi
---What each game's saves were last found to be, so the play bar has a status before a sync
---@return CloudSaves[]
function GetCloudSaves()
  local result = {}
  for app_name, entry in pairs(record.get()) do
    if type(entry) == "table" and type(entry.status) == "string" then
      table.insert(result, {
        app_name = app_name,
        status = entry.status,
        local_at = entry.local_at,
        remote_at = entry.remote_at,
        synced_at = entry.synced_at,
        error = entry.error,
      })
    end
  end
  return result
end
