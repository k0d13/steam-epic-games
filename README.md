# Epic Games <a href='https://ko-fi.com/X8X554X28' target='_blank'>☕</a>

A Millennium plugin that brings your Epic Games library into Steam - install, launch and track playtime without leaving the client.

> [!IMPORTANT]
> Work in progress. The pieces below work, but this hasn't been tested on many
> Steam builds or many machines yet, and every patch it applies reaches into
> Steam's own stores. Expect rough edges, and expect them to move.

## What it does

- Every game you own on Epic appears in your Steam library
- Install, update, pause and uninstall from Steam, with progress on the library tile
- Launch from Steam, with playtime tracking, "Currently playing" and the overlay
- Full artwork: box art, heroes, headers and icons
- Uninstalled games behave like uninstalled Steam games - greyed out, with an Install button

## Prerequisites

- [Millennium](https://steambrew.app/)

[Legendary](https://github.com/derrod/legendary) ships with the plugin, so
there's nothing else to install and nothing is downloaded at runtime.

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

### Why does a terminal flash on screen?

Legendary is a console application and Steam has no console, so every command
pops up a terminal window for as long as it runs. Millennium has no way to
start a process without one.

Downloads are the exception — those run hidden in the background, so a
multi-gigabyte install won't leave a console window on your screen for an hour.
