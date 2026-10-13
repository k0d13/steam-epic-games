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

- Windows
- [Millennium](https://steambrew.app/)

That's it. The plugin talks to Epic through
[Legendary](https://github.com/derrod/legendary), which it downloads for you the
first time it runs.

## Setup

1. In Steam, open **Store > Epic Games Store** and sign in to Epic there.
2. Open the **Epic Games** panel from Millennium's plugin list. It shows the
   account you signed in with and your Epic library.
3. Press **Add to Steam**.

The first run takes a few minutes on a large account. After that it only picks
up what's changed. Signing out of the Epic store signs the plugin out too.
