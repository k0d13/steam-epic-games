# Epic Games <a href='https://ko-fi.com/X8X554X28' target='_blank'>☕</a>

A Millennium plugin that brings your Epic Games library into Steam - install, launch and track
playtime without leaving the client.

> [!IMPORTANT]
> Work in progress. The pieces below work, but this hasn't been tested on many
> Steam builds or many machines yet, and every patch it applies reaches into
> Steam's own stores. Expect rough edges, and expect them to move.

## What it does

- Every game you own on Epic appears in your Steam library, with an Epic badge on the tile
- Install, update, pause and uninstall from Steam, with progress on the library tile
- Launch from Steam, with playtime tracking, "Currently playing" and the overlay
- Full artwork: box art, heroes, headers and icons
- Epic achievements in the app details page and Steam's achievements page
- Uninstalled games behave like uninstalled Steam games - greyed out, with an Install button

## Prerequisites

- [Millennium](https://steambrew.app/)

That's it. The plugin talks to Epic through
[Legendary](https://github.com/derrod/legendary), which it downloads for you the
first time it runs.

## Setup

1. Open the **Epic Games** panel from Millennium's plugin list.
2. Press **Sign in**. Epic's login page opens in your browser.
3. Epic will show you a page of text. Copy all of it, paste it into the panel,
   and press **Continue**.
4. Press **Add to Steam**.

The first run takes a few minutes on a large account. After that it only picks
up what's changed.

> [!NOTE]
> The code Epic gives you is good for one use and expires quickly. If
> **Continue** doesn't work, press **Sign in** again for a fresh one.

## Notes & Troubleshooting

### Why does a terminal flash on screen when Steam starts?

Steam gives Legendary nowhere to run, so the plugin starts a hidden background
helper when Steam loads and runs every command through that instead. Starting it
is the one thing that can't be hidden, hence the flash. You should only see it
once per Steam launch.
