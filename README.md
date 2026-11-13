<div align="center">

# Epic Games for Steam

[![Release](https://img.shields.io/github/v/release/k0d13/steam-epic-games?style=for-the-badge&color=66c0f4&labelColor=171a21)](https://github.com/k0d13/steam-epic-games/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/k0d13/steam-epic-games/total?style=for-the-badge&color=66c0f4&labelColor=171a21)](https://github.com/k0d13/steam-epic-games/releases)
[![Quality](https://img.shields.io/github/actions/workflow/status/k0d13/steam-epic-games/release.yml?branch=main&style=for-the-badge&label=build&labelColor=171a21)](https://github.com/k0d13/steam-epic-games/actions/workflows/release.yml)
[![Stars](https://img.shields.io/github/stars/k0d13/steam-epic-games?style=for-the-badge&color=f5c518&labelColor=171a21)](https://github.com/k0d13/steam-epic-games/stargazers)

[![Millennium](https://img.shields.io/badge/Millennium-plugin-7c3aed?style=flat-square&logo=steam&logoColor=white)](https://steambrew.app/)
[![Windows](https://img.shields.io/badge/Windows-supported-0078d4?style=flat-square&logo=windows&logoColor=white)](#-get-started)
[![Linux](https://img.shields.io/badge/Linux-Proton-fcc624?style=flat-square&logo=linux&logoColor=black)](#-get-started)
[![Lua](https://img.shields.io/badge/Lua-2c2d72?style=flat-square&logo=lua&logoColor=white)](backend)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](frontend)
[![License](https://img.shields.io/badge/license-CC%20BY--NC--ND%204.0-ef4444?style=flat-square)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/X8X554X28)

**Your Epic library, inside Steam.** Install, launch, track playtime and sync saves without ever opening the Epic launcher.

</div>

<br>

<p align="center">
  <img src=".github/assets/screenshots/game-page.png" alt="Fall Guys on its Steam game page" width="100%">
</p>

> [!WARNING]
> **Work in progress.** Every patch reaches into Steam's own stores, and it hasn't seen many Steam builds or machines yet. Expect rough edges.

## ✨ Features

|                          |                                                                                       |
| :----------------------- | :------------------------------------------------------------------------------------ |
| 📚 **Library**           | Every Epic game you own, with full artwork and an Epic badge on the tile              |
| ⬇️ **Downloads**         | Install, update, pause and uninstall with progress on the tile and the Downloads page |
| ▶️ **Launch**            | Playtime reported to Epic, "Currently playing" and the Steam overlay                  |
| ☁️ **Cloud saves**       | Synced before launch and after exit, with Steam's Cloud Status and conflict dialogs   |
| 🏆 **Achievements**      | On the game page and Steam's achievements page                                        |
| 🧩 **DLC**               | Installs with its game, and managed from Properties > DLC                             |
| 🛠️ **Verify & repair**   | Fix corrupted or missing files from Properties > Installed Files                      |
| 🛒 **Store**             | An Epic Games Store submenu; anything you buy or claim lands in your library          |
| 🔗 **Existing installs** | Games from the Epic launcher show as installed, not as a second download              |

## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/library.png" alt="The Epic Games collection in the Steam library"></td>
    <td width="50%"><img src=".github/assets/screenshots/achievements.png" alt="Fall Guys achievements"></td>
  </tr>
  <tr>
    <td align="center"><sub>Your Epic games, right in the library</sub></td>
    <td align="center"><sub>Epic achievements on Steam's own page</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/install.png" alt="Installing Fall Guys"></td>
    <td width="50%"><img src=".github/assets/screenshots/downloads.png" alt="Fall Guys downloading"></td>
  </tr>
  <tr>
    <td align="center"><sub>Steam's install dialog</sub></td>
    <td align="center"><sub>Downloads with Steam's own progress</sub></td>
  </tr>
</table>

## 🚀 Get started

You need **Steam** with [**Millennium**](https://steambrew.app/), on Windows or Linux. Nothing else: [Legendary](https://github.com/derrod/legendary) is downloaded for you on first run.

> [!IMPORTANT]
> You must be on **Millennium v3.6.3-beta.1 or higher**.

1. **Install.** Download the `.star` file from the [latest release](https://github.com/k0d13/steam-epic-games/releases/latest) and move it into Millennium's plugins folder, then restart Steam and enable **Epic Games** in Millennium's plugin list.
   - Windows: `C:\Program Files (x86)\Steam\millennium\plugins`
   - Linux: `~/.local/share/Steam/millennium/plugins`
2. **Sign in.** In Steam, open **Store > Epic Games Store** and sign in to Epic.
3. **Open the panel.** Pick **Epic Games** from Millennium's plugin list.
4. **Add to Steam.** Press the button and let it run.

> [!TIP]
> The first sync takes a few minutes on a big library. After that, only changes are picked up.

## 🩺 Troubleshooting

Everything the plugin stores lives in its data folder, inside your Steam folder:

- Windows: `C:\Program Files (x86)\Steam\millennium\data\epic-games`
- Linux: `~/.local/share/Steam/millennium/data/epic-games`

`plugin.log` in that folder records what the plugin did and any errors. Attach it when you [open an issue](https://github.com/k0d13/steam-epic-games/issues/new).

<details>
<summary><b>Signing in fails with <code>network-error</code> after the captcha</b></summary>

Epic can reject email and password sign-ins from Steam's browser, depending on your account or region ([#19](https://github.com/k0d13/steam-epic-games/issues/19)). Sign in with Steam, Google or another provider instead. If your Epic account only has a password, link one of those to it first in your [Epic account settings](https://www.epicgames.com/account/connections).

</details>

<details>
<summary><b>The plugin doesn't show up or won't load</b></summary>

Check you're on Millennium v3.6.3-beta.1 or higher, that the `.star` file is directly inside the plugins folder, and that **Epic Games** is enabled in Millennium's plugin list. Restart Steam after any change.

</details>

## 💖 Support

If this saves you from opening the Epic launcher, consider [buying me a coffee on Ko-fi](https://ko-fi.com/X8X554X28) ☕

<div align="center">
<sub>Not affiliated with Valve or Epic Games.</sub>
</div>
