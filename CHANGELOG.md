# epic-games

## 0.7.0

### Minor Changes

- 3b1f8b4: Sync Epic cloud saves around launches, with Steam's Cloud Status,
  dialogs and notifications. Always report play time
- 8b52d05: Show the activity feed for every Epic game, not only those with
  achievements
- 2db66d8: Notify when Epic's free games change each Thursday at 8:00 AM
  Pacific, and open them when clicked
- 72e4db6: Add DLC support through Steam's native DLC section and Properties tab,
  installing owned DLC with its game and from Epic's own data
- b3da35d: Verify and repair Epic installs from an Installed Files tab in the
  game's properties, showing Validating on the tile and bottom bar. Drop the
  cancel items from Manage

## 0.6.0

### Minor Changes

- 5394149: Source game info, tags and install sizes from egdata.app
- 9c827d4: Apply egdata genres to Epic games as Steam store tags, for filters and
  collections
- b8adf4a: Add options to scan every game's info and achievements, and to clear
  the caches
- c4243c9: Open Epic's developer, publisher and franchise links in Steam instead
  of the system browser
- fbd0214: Keep play time and last played by Epic app name, show Epic's play
  time, and optionally report Steam sessions to Epic
- ec7970b: Show Epic achievement unlocks in Steam's activity feed

### Patch Changes

- e29cdab: Put game info behind a setting, off by default, so it can't clash with
  other plugins

## 0.5.0

### Minor Changes

- 6db0fff: Show Steam's game info panel and button on Epic games
- e8e829f: Add Store Page, FAQ and Support links to Epic games' link bar

## 0.4.0

### Minor Changes

- 34f0ef0: Add Linux support, running shell commands and the legendary download
  and install jobs there and skipping the Epic Games Launcher import. macOS is
  still not supported
- be54447: Run Epic games through a chosen Proton on Linux, with a prefix per
  game

## 0.3.0

### Minor Changes

- c43a2d6: Add a library clean up, make sync adopt existing shortcuts, and
  rebuild the plugin panel
- c806d0a: Refresh the library after an Epic order in Steam's browser and show a
  toast with what it found
- d72f3a7: Raise Steam's own download notification for Epic installs and refresh
  the bottom bar
- 00001a0: Add Uninstall and Cancel to the Manage menu on Epic games

## 0.2.0

### Minor Changes

- b14ea5a: Show installed Epic games in Steam's storage settings
- 68474ae: Show Epic installs on Steam's downloads page
- 0eb0860: Add an Epic Games section to Steam's Store menu, with links into the
  Epic store
- f29d5a9: Sign in by following the Epic store's sign in from Steam's browser,
  replacing the separate sign-in panel

## 0.1.0

### Minor Changes

- e4e632b: Initial release: sync your Epic Games library into Steam as non-Steam
  shortcuts, with correct installed/uninstalled state, artwork from Epic's
  catalog, and install, uninstall and launch driven by legendary
- 019a9a7: Add an Install button to Epic games, with pause and resume, and show
  the disk space a game needs before you install it
- 4271dba: Mark Epic games with an Epic Games badge in the library, and in the
  grid and home views
- eabcecd: Show your Epic achievements in Steam's app details and on the
  achievements page
- abfdffa: Hide Epic games you already own on Steam, in bulk from the plugin
  panel
- 4ccd914: Collect every Epic shortcut into an Epic Games collection
- 56fd26b: Feed Epic achievement counts to the library's completion sort, and
  re-read achievements when a game has been played since they were last
  fetched
- 794e0e2: Queue installs so they run one after another instead of all at once
- ad892cf: Update installed games from Epic's latest build
- d6e252f: Show Epic ownership on Steam store pages
- ff15d84: Show Epic purchase dates as library activity
