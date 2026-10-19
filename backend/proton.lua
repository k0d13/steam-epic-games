--# selene: allow(unused_variable)
local cache = require("cache")
local fs = require("fs")
local log = require("log")
local millennium = require("millennium")
local paths = require("paths")
local utils = require("utils")

-- Linux only: which Proton runs Epic games. Shortcuts keep launching legendary
-- the same way on both platforms; Proton is set in legendary's own config.ini,
-- which it reads on every `launch`, so changing it touches no shortcut.
--
-- [default] gets the wrapper, and each game gets an [<app>.env] section with a
-- prefix of its own, so one game's fixes or crash can't break another's.

local proton = {}

local STATE_PATH = paths.DATA .. "/proton.json"
local PREFIXES = paths.DATA .. "/prefixes"

--- Windows runs games natively, so there's nothing to choose.
local SUPPORTED = not paths.IS_WINDOWS

---@class ProtonBuild
---@field name string Its folder name, which is what Steam shows
---@field path string The folder holding its `proton` script

---Every Proton Steam has installed: Valve's under steamapps/common, and custom
---builds like GE-Proton under compatibilitytools.d.
---@return ProtonBuild[]
function proton.list()
  local steam = millennium.steam_path()
  local builds = {}

  for _, root in ipairs({ steam .. "/steamapps/common", steam .. "/compatibilitytools.d" }) do
    for _, entry in ipairs(fs.list(root) or {}) do
      if entry.is_directory and fs.is_file(entry.path .. "/proton") then
        table.insert(builds, { name = entry.name, path = entry.path })
      end
    end
  end

  table.sort(builds, function(a, b)
    return a.name > b.name
  end)
  return builds
end

---The chosen build's folder, if it's still installed.
---@return string|nil
function proton.selected()
  local state = cache.read(STATE_PATH, "Proton choice")
  local path = state and state.path
  if type(path) == "string" and fs.is_file(path .. "/proton") then
    return path
  end
  return nil
end

---An INI file as sections of raw lines, so whatever legendary or the user wrote
---survives a rewrite untouched. The lines before any header have no name.
---@param text string
---@return { name: string|nil, lines: string[] }[]
local function parse(text)
  local sections = { { name = nil, lines = {} } }
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    line = line:gsub("\r$", "")
    local name = line:match("^%s*%[(.-)%]%s*$")
    if name then
      table.insert(sections, { name = name, lines = { line } })
    else
      table.insert(sections[#sections].lines, line)
    end
  end
  return sections
end

---@param sections { name: string|nil, lines: string[] }[]
---@return string
local function serialize(sections)
  local lines = {}
  for _, section in ipairs(sections) do
    for _, line in ipairs(section.lines) do
      table.insert(lines, line)
    end
  end
  -- The parse adds an empty line for the final newline; one is plenty.
  while lines[#lines] == "" do
    table.remove(lines)
  end
  return table.concat(lines, "\n") .. "\n"
end

---Set a key in a section, creating the section if it's missing, or remove the
---key when `value` is nil.
---@param sections { name: string|nil, lines: string[] }[]
---@param name string
---@param key string
---@param value string|nil
local function set(sections, name, key, value)
  local section
  for _, candidate in ipairs(sections) do
    if candidate.name == name then
      section = candidate
    end
  end

  if not section then
    if value == nil then
      return
    end
    section = { name = name, lines = { "", "[" .. name .. "]" } }
    table.insert(sections, section)
  end

  local found
  for index, line in ipairs(section.lines) do
    if line:match("^%s*([^=:%s]+)%s*[=:]") == key then
      found = index
      break
    end
  end

  if value ~= nil then
    local entry = key .. " = " .. value
    if found then
      section.lines[found] = entry
      return
    end

    -- After the last key, not after the blank lines that close the section.
    local at = #section.lines + 1
    while section.lines[at - 1] == "" do
      at = at - 1
    end
    table.insert(section.lines, at, entry)
    return
  end

  if not found then
    return
  end
  table.remove(section.lines, found)

  -- A section left with nothing but its header goes with its last key.
  for _, line in ipairs(section.lines) do
    if line:match("^%s*[^%s%[#;]") then
      return
    end
  end
  for index, candidate in ipairs(sections) do
    if candidate == section then
      table.remove(sections, index)
      return
    end
  end
end

---Write the chosen Proton into legendary's config for every game, or take it
---back out when none is chosen. Called after each refresh, so new games get one.
---@param app_names string[]
---@return boolean ok
function proton.apply(app_names)
  if not SUPPORTED then
    return true
  end

  local path = paths.legendary_config() .. "/config.ini"
  local selected = proton.selected()
  local sections = parse(fs.is_file(path) and utils.read_file(path) or "")

  -- Quoted for legendary's shlex.split, since build names have spaces.
  local wrapper = selected and ("'" .. selected:gsub("'", "'\\''") .. "/proton' run") or nil
  set(sections, "default", "wrapper", wrapper)
  set(sections, "default", "no_wine", selected and "true" or nil)

  for _, app_name in ipairs(app_names) do
    local prefix = PREFIXES .. "/" .. app_name
    if selected then
      fs.create_directories(prefix)
    end
    local env = app_name .. ".env"
    set(sections, env, "STEAM_COMPAT_DATA_PATH", selected and prefix or nil)
    set(
      sections,
      env,
      "STEAM_COMPAT_CLIENT_INSTALL_PATH",
      selected and millennium.steam_path() or nil
    )
  end

  fs.create_directories(fs.parent_path(path))
  local ok, err = utils.write_file(path, serialize(sections))
  if not ok then
    log.error("Could not write legendary's config: " .. tostring(err))
    return false
  end
  return true
end

---@class ProtonChoice
---@field supported boolean False on Windows, where games run natively
---@field builds ProtonBuild[]
---@field selected string|nil The chosen build's folder

---@ffi
---The Proton builds to choose from and the one chosen. Empty on Windows.
---@return ProtonChoice
function GetProton()
  if not SUPPORTED then
    return { supported = false, builds = {}, selected = nil }
  end
  return { supported = true, builds = proton.list(), selected = proton.selected() }
end

---@ffi
---Choose the Proton every Epic game runs through, or none with an empty path.
---@param path string
---@param app_names string[] Every game in the library
---@return boolean ok
function SetProton(path, app_names)
  cache.write(STATE_PATH, { path = path ~= "" and path or nil }, "Proton choice")
  log.info("Proton set to " .. (path ~= "" and path or "none"))
  return proton.apply(app_names)
end

return proton
