# epic-games

## 0.7.0

### Minor Changes

- 3b1f8b4: Syncs Epic cloud saves around launches, with Steam's Cloud Status,
  dialogs and notifications. Play time is now always reported alongside
  them.
- 8b52d05: Shows the activity feed for every Epic game, not only those with
  achievements.
- 2db66d8: Notifies you when Epic's free games change each Thursday at 8:00 AM
  Pacific, and opens them when clicked.
- 72e4db6: Adds DLC support through Steam's native DLC section and Properties tab,
  installing owned DLC with its game and from Epic's own data.
- b3da35d: Verifies and repairs Epic installs from an Installed Files tab in the
  game's properties, showing Validating on the tile and bottom bar. The
  cancel items are dropped from Manage.

## 0.6.0

### Minor Changes

- 5394149: Sources game info, tags and install sizes from egdata.app.
- 9c827d4: Applies egdata genres to Epic games as Steam store tags, for filters and
  collections.
- b8adf4a: Adds options to scan every game's info and achievements, and to clear
  the caches.
- c4243c9: Opens Epic's developer, publisher and franchise links in Steam instead
  of the system browser.
- fbd0214: Keeps play time and last played by Epic app name, shows Epic's play
  time, and can optionally report Steam sessions to Epic.
- ec7970b: Shows Epic achievement unlocks in Steam's activity feed.

### Patch Changes

- e29cdab: Puts game info behind a setting, off by default, so it can't clash with
  other plugins.

## 0.5.0

### Minor Changes

- 6db0fff: Shows Steam's game info panel and button on Epic games.
- e8e829f: Adds Store Page, FAQ and Support links to Epic games' link bar.

## 0.4.0

### Minor Changes

- 34f0ef0: Adds Linux support. Shell commands, the legendary download and install
  jobs now run on Linux, and the Epic Games Launcher import is skipped
  there. macOS is still not supported.
- be54447: Runs Epic games through a chosen Proton on Linux, with a prefix per
  game.

## 0.3.0

### Minor Changes

- c43a2d6: Adds a library clean up, makes sync adopt existing shortcuts, and
  rebuilds the plugin panel.
- c806d0a: Refreshes the library after an Epic order in Steam's browser and shows a
  toast with what it found.
- d72f3a7: Raises Steam's own download notification for Epic installs and refreshes
  the bottom bar.
- 00001a0: Adds Uninstall and Cancel to the Manage menu on Epic games.

## 0.2.0

### Minor Changes

- b14ea5a: Shows installed Epic games in Steam's storage settings.
- 68474ae: Shows Epic installs on Steam's downloads page.
- 0eb0860: Adds an Epic Games section to Steam's Store menu, with links into the
  Epic store.
- f29d5a9: Signs you in by following the Epic store's sign in from Steam's browser,
  replacing the separate sign-in panel.

## 0.1.0

### Minor Changes

- e4e632b: Initial release. Syncs your Epic Games library into Steam as non-Steam
  shortcuts, with correct installed/uninstalled state, artwork from Epic's
  catalog, and install, uninstall and launch driven by legendary.
- 019a9a7: Adds an Install button to Epic games, with pause and resume, and shows
  the disk space a game needs before you install it.
- 4271dba: Marks Epic games with an Epic Games badge in the library, and in the
  grid and home views.
- eabcecd: Shows your Epic achievements in Steam's app details and on the
  achievements page.
- abfdffa: Hides Epic games you already own on Steam, in bulk from the plugin
  panel.
- 4ccd914: Collects every Epic shortcut into an Epic Games collection.
- 56fd26b: Feeds Epic achievement counts to the library's completion sort, and
  re-reads achievements when a game has been played since they were last
  fetched.
- 794e0e2: Queues installs so they run one after another instead of all at once.
- ad892cf: Updates installed games from Epic's latest build.
- d6e252f: Shows Epic ownership on Steam store pages.
- ff15d84: Shows Epic purchase dates as library activity.
