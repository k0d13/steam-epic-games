-- Bytes on their way to somewhere that only accepts text.
--
-- legendary's output arrives as whatever the console handed us, so a game name
-- can carry a sequence that is not valid UTF-8. Lua and cjson both pass those
-- through untouched, and the JSON that comes out of it crashes Millennium's own
-- parser rather than failing the call, which is why anything read off a command
-- is checked here before it goes any further.
--
-- Done by hand rather than with the `utf8` library: Millennium's Lua is 5.1,
-- which has no such library, and indexing it is an error the host turns into a
-- crash rather than a failed call.

local text = {}

local byte = string.byte

local REPLACEMENT = "\239\191\189"

---How long the sequence starting at `i` is, or nil if it doesn't start one.
---
---Strict in the ways Millennium's JSON parser is: an overlong encoding, a
---surrogate half and anything past U+10FFFF are all rejected rather than
---decoded, since they are what a parser downstream will refuse as well.
---@param value string
---@param i integer
---@param n integer
---@return integer|nil next Index of the byte after the sequence
local function step(value, i, n)
  local first = byte(value, i)
  if first < 0x80 then
    return i + 1
  end

  local extra, point, lowest
  if first >= 0xC2 and first <= 0xDF then
    extra, point, lowest = 1, first - 0xC0, 0x80
  elseif first >= 0xE0 and first <= 0xEF then
    extra, point, lowest = 2, first - 0xE0, 0x800
  elseif first >= 0xF0 and first <= 0xF4 then
    extra, point, lowest = 3, first - 0xF0, 0x10000
  else
    -- A continuation byte with nothing in front of it, or a length no encoding
    -- ever had.
    return nil
  end

  if i + extra > n then
    return nil
  end

  for offset = 1, extra do
    local continuation = byte(value, i + offset)
    if continuation < 0x80 or continuation > 0xBF then
      return nil
    end
    point = point * 64 + (continuation - 0x80)
  end

  if point < lowest or point > 0x10FFFF or (point >= 0xD800 and point <= 0xDFFF) then
    return nil
  end

  return i + extra + 1
end

---Where the first byte that isn't part of a valid UTF-8 sequence is, if there
---is one.
---@param value string
---@return integer|nil position 1-based, nil when the whole string is valid
function text.first_invalid(value)
  local i, n = 1, #value
  while i <= n do
    local next_index = step(value, i, n)
    if not next_index then
      return i
    end
    i = next_index
  end

  return nil
end

---Replace every byte that isn't part of a valid UTF-8 sequence.
---@param value string
---@return string scrubbed
---@return integer replaced How many bytes had to be replaced
---@return integer|nil position Where the first of them was
function text.scrub(value)
  local first = text.first_invalid(value)
  if not first then
    return value, 0
  end

  local out, replaced = {}, 0
  local i, n = 1, #value
  -- Where the run of bytes that are fine but not yet copied begins, so a string
  -- with one bad byte in it is two substrings and not one per character.
  local kept = 1

  while i <= n do
    local next_index = step(value, i, n)
    if next_index then
      i = next_index
    else
      if i > kept then
        table.insert(out, value:sub(kept, i - 1))
      end
      table.insert(out, REPLACEMENT)
      replaced = replaced + 1
      i = i + 1
      kept = i
    end
  end

  if n >= kept then
    table.insert(out, value:sub(kept, n))
  end

  return table.concat(out), replaced, first
end

---The bytes around one position, as hex. What a crash report needs to say which
---game's name broke, since the name itself is the thing that won't encode.
---@param value string
---@param position integer
---@param radius? integer Bytes either side, 16 by default
---@return string
function text.window(value, position, radius)
  radius = radius or 16
  local from = math.max(1, position - radius)
  local to = math.min(#value, position + radius)

  local bytes = {}
  for i = from, to do
    table.insert(bytes, string.format("%02x", byte(value, i)))
  end

  return string.format("@%d %s", position, table.concat(bytes, " "))
end

return text
