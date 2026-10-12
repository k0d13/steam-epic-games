local millennium = require("millennium")

-- Where the plugin keeps everything it writes: Millennium's data folder for it,
-- which is what `utils.get_backend_path()` points at for an installed .star.
-- Not that call itself, because under `starlight watch` it comes back empty and
-- everything landed in the root of the drive.
return millennium.steam_path() .. "/millennium/data/epic-games"
