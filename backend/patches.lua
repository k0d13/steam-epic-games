-- Edits Millennium makes to Steam's JavaScript as it serves it; one whose `find` stops
-- matching after a Steam update is skipped. `#{{self}}` is our PLUGIN_LIST slot
--
-- A `find` has no backreferences, and a `\1` in a `replace` followed by a letter or digit,
-- `#{{self}}` included as it starts `window`, reads as a longer group and fails every patch

return {
  -- Manage has no Uninstall or Cancel for shortcuts, so library/manage-menu.ts adds them to
  -- what Steam built, and Steam's own menu stays while the frontend isn't there
  {
    file = [[sp\.js]],
    find = [[this\.BuildManageSubmenu\([^)]*\)]],
    transforms = {
      {
        match = [[this\.BuildManageSubmenu\(([\w$]+),([\w$]+),([\w$]+)\)]],
        replace = [[(#{{self}}?.ManageSubmenu??(m=>m))(this.BuildManageSubmenu(\1,\2,\3),\1)]],
      },
    },
  },

  -- General, Installed Files and DLC are only a Steam game's pages, so properties/installed-files.tsx
  -- swaps Shortcut for General and adds the other two; General and DLC are Steam's, from further down
  {
    file = [[sp\.js]],
    find = [[\{[^{]*ShortcutPage".*?\{[^{]*DLCPage.*?\}\)\}]],
    transforms = {
      {
        match = [[^(\{.*?Shortcut\(([\w$]+)\).*?\}\)\})(.*?)(\{[^{]*GeneralPage.*?\}\)\})(.*?)(\{[^{]*DLCPage.*)$]],
        replace = [[...(#{{self}}?.PropertiesPages?.(\2,\1,\4,\6)??[\1])\3\4\5\6]],
      },
    },
  },

  -- Steam's URLs: game-page/friends.ts sends an Epic friend's profile to Epic, and game-page/dlc.ts
  -- answers "View DLC In Store"'s steam://url/StoreDlcPage/<appid> by opening Epic's page
  {
    file = [[sp\.js]],
    find = [[ResolveURL\([\w$]+,\.\.\.[\w$]+\)\{const [\w$]+=this\.m_steamUrls\[.*?BuildSteamURL\([\w$]+,\.\.\.[\w$]+\)\{return"steam://url/"]],
    transforms = {
      {
        match = [[(ResolveURL|BuildSteamURL)\(([\w$]+),\.\.\.([\w$]+)\)\{]],
        replace = [[\1(\2,...\3){const epicGames=#{{self}}?.\1?.(\2,\3);if(epicGames)return epicGames;]],
      },
    },
  },

  -- Every app's details reach the app data store through AppDetailsChanged, so
  -- library/app-details.ts fixes an Epic game's before they're stored and listeners see them
  {
    file = [[sp\.js]],
    find = [[AppDetailsChanged\([\w$]+\)\{this\.m_mapAppData\.has\(]],
    transforms = {
      {
        match = [[AppDetailsChanged\(([\w$]+)\)\{]],
        replace = [[AppDetailsChanged(\1){#{{self}}?.AppDetailsChanged?.(\1);]],
      },
    },
  },

  -- Supernav menus, which store/menu.ts splits into Steam and Epic submenus for Store. Steam's entry
  -- renderer is the menu class's sibling, so it's named here under a name no minified local shadows
  {
    file = [[sp\.js]],
    find = [[const [\w$]+=[\w$]+=>\{const\{disabledItemClass:.*?\.CreateContextMenuInstance\([^}]*\}\),[^{}]*\{[^}]*\}\)]],
    transforms = {
      {
        match = [[const ([\w$]+)=([\w$]+=>\{const\{disabledItemClass:.*?)\.CreateContextMenuInstance\((\(0,[\w$]+\.jsx\)\([\w$]+,\{refContextMenu:([\w$]+),[^}]*\}\)),([^{}]*\{[^}]*title:([\w$]+),[^}]*\})\)]],
        replace = [[const epicGamesSupernavItems=()=>\1,\1=\2.CreateContextMenuInstance((#{{self}}?.SupernavMenu??(m=>m))(\3,\6,\4,epicGamesSupernavItems),\5)]],
      },
    },
  },

  -- Epic's pages in Steam's browser light the Store tab, rather than keeping
  -- whichever was last
  {
    file = [[sp\.js]],
    find = [[GetTabForURL\([\w$]+\)\{if\(]],
    transforms = {
      {
        match = [[GetTabForURL\(([\w$]+)\)\{if\(]],
        replace = [[GetTabForURL(\1){if(#{{self}}?.IsEpicURL?.(\1)||]],
      },
    },
  },

  -- A shortcut's details page keeps a few sections, so game-page/game-info.ts puts back the info
  -- panel and Achievements; anchored on the shortcut list, as BIsModOrShortcut is asked elsewhere too
  {
    file = [[sp\.js]],
    find = [["screenshots"\];.*?\)&&\([\w$]+=[\w$]+\)]],
    transforms = {
      {
        match = [[([\w$]+)\.BIsModOrShortcut\(\)&&\(([\w$]+)=([\w$]+)\)]],
        replace = [[\1.BIsModOrShortcut()&&(\2=(#{{self}}?.ShortcutSections?.(\1,\3)??\3))]],
      },
    },
  },

  -- The links under the play bar (Store Page, Community Hub and so on) are only built
  -- for a Steam game, so a shortcut's bar is empty. game-page/game-info.ts adds Epic's links
  {
    file = [[sp\.js]],
    find = [[bMarketPresence:[\w$]+\}=[\w$]+,[\w$]+=[\w$]+\.BIsModOrShortcut\(\),.*?=\[\];if\(![\w$]+\)\{]],
    transforms = {
      {
        match = [[([\w$]+)\.BIsModOrShortcut\(\)(.*?)([\w$]+)=\[\];if\(!([\w$]+)\)\{]],
        replace = [[\1.BIsModOrShortcut()\2\3=[];if(\4){\3.push(...(#{{self}}?.ShortcutLinks?.(\1)??[]))}if(!\4){]],
      },
    },
  },

  -- The info panel's developer, publisher and franchise anchors go through steam://openurl/, which
  -- sends non-Steam pages to the system browser, so services/epic/store.ts opens Epic's in the client
  {
    file = [[sp\.js]],
    find = [[this\.GetURL\([\w$]+\.strName,.{0,80}?\.Name,href:[\w$]+,]],
    transforms = {
      {
        match = [[this\.GetURL\(([\w$]+)\.strName,(.*?href:[\w$]+),$]],
        replace = [[this.GetURL(\1.strName,\2,onClick:#{{self}}?.EpicLinkClick?.(\1.strURL),]],
      },
    },
  },

  -- The info panel draws a shortcut as a bare explanation, so game-page/game-info.ts says an Epic
  -- game with info isn't one; the panel reads its shortcut state at the top of render
  {
    file = [[sp\.js]],
    find = [[=this\.props\.overview\.BIsModOrShortcut\(\),]],
    transforms = {
      {
        match = [[=this\.props\.overview\.BIsModOrShortcut\(\),]],
        replace = [[=this.props.overview.BIsModOrShortcut()&&!#{{self}}?.HasGameInfo?.(this.props.overview),]],
      },
    },
  },

  -- A shortcut's info panel starts open, and an Epic game's should start as a Steam game's does;
  -- its info arrives after the page has drawn, so this can't wait for HasGameInfo
  {
    file = [[sp\.js]],
    find = [[bShowGameInfo:[\w$]+\.overview\.BIsModOrShortcut\(\)\|\|]],
    transforms = {
      {
        match = [[bShowGameInfo:([\w$]+)\.overview\.BIsModOrShortcut\(\)\|\|]],
        replace = [[bShowGameInfo:\1.overview.BIsModOrShortcut()&&!#{{self}}?.IsEpicGame?.(\1.overview)||]],
      },
    },
  },

  -- The play bar's button that opens the info panel, which a shortcut doesn't get
  {
    file = [[sp\.js]],
    find = [[![\w$]+\.BIsModOrShortcut\(\)&&.{0,80}?bShowInfoExpanded]],
    transforms = {
      {
        match = [[!([\w$]+)\.BIsModOrShortcut\(\)&&]],
        replace = [[(!\1.BIsModOrShortcut()||#{{self}}?.HasGameInfo?.(\1))&&]],
      },
    },
  },

  -- The play bar's Cloud Status and its narrow status row bail for a shortcut before reading the
  -- details, so game-page/cloud.ts fills them in for an Epic game whose saves it syncs
  {
    file = [[sp\.js]],
    find = [[\|\|[\w$]+\.BIsModOrShortcut\(\)\)return null;.*?\.details\.eCloudStatus.*?\.details\.eCloudStatus]],
    transforms = {
      {
        match = [[\|\|([\w$]+)\.BIsModOrShortcut\(\)\)return null;]],
        replace = [[||\1.BIsModOrShortcut()&&!#{{self}}?.IsEpicApp?.(\1.appid))return null;]],
      },
    },
  },

  -- The full achievements page's store, whose three getters ask game-page/achievements.ts
  -- first, so an Epic game's page isn't Steam's cached "Failed to retrieve user stats"
  {
    file = [[sp\.js]],
    find = [[GetPlayerAchievements\(.*?GetGlobalAchievements\([\w$]+\)\{]],
    transforms = {
      {
        match = [[(GetMyAchievements|GetGlobalAchievements|GetPlayerAchievements)\(([\w$]+)(,[\w$]+)?\)\{]],
        replace = [[\1(\2\3){const epicGames=#{{self}}?.AchievementStore?.("\1",\2);if(epicGames)return epicGames;]],
      },
    },
  },

  -- The feed's status box posts about the app to friends, and Steam's servers have no Epic game,
  -- so an Epic game's feed has no box
  {
    file = [[sp\.js]],
    find = [[render\(\)\{const\{appid:[\w$]+,showTextBox:[\w$]+\}=this\.props,]],
    transforms = {
      {
        match = [[render\(\)\{const\{appid:([\w$]+),showTextBox:([\w$]+)\}=this\.props,]],
        replace = [[render(){const{appid:\1,showTextBox:epicGamesTextBox}=this.props,\2=epicGamesTextBox&&!#{{self}}?.IsEpicApp?.(\1),]],
      },
    },
  },

  -- Steam's artwork component, for every icon and capsule, so library/badge.ts can add the Epic mark;
  -- app, appid and asset type are read at the top of render, so the match runs up to the container
  {
    file = [[sp\.js]],
    find = [[render\(\)\{let\{app:.*?\("div",\{className:[\w$]+,children:\[]],
    transforms = {
      {
        match = [[(render\(\)\{let\{app:([\w$]+),appid:([\w$]+),.*?eAssetType:([\w$]+),.*?children:\[)$]],
        replace = [[\1(#{{self}}?.LibraryBadge?.(\2?.appid??\3,\4)),]],
      },
    },
  },

  -- The feed draws a friend's row from the friend store and hides non-friends, so
  -- game-page/friends.ts gives an Epic friend's stand-in a name, a default avatar and friendship
  {
    file = [[sp\.js]],
    find = [[GetFriendState\([\w$]+\)\{const [\w$]+=typeof [\w$]+=="number"\?[\w$]+:[\w$]+\.GetAccountID\(\),[\w$]+=this\.m_FriendsUIFriendStore\.GetPlayer\([\w$]+\);return [^}]*\}]],
    transforms = {
      {
        match = [[return ([\w$]+)\.is_ready\?[\w$]+:this\.m_mapPlayerCache\.get\(([\w$]+)\)\|\|[\w$]+\}$]],
        replace = [[return (#{{self}}?.FriendState??((a,b)=>b))(\2,\1.is_ready?\1:this.m_mapPlayerCache.get(\2)||\1)}]],
      },
    },
  },

  -- Steam's avatar component, which every friend's picture goes through, so
  -- library/badge.ts can add the Epic mark to a stand-in's persona
  {
    file = [[sp\.js]],
    find = [[strAvatarURL:[\w$]+,size:[\w$]+,className:\(0,[\w$]+\.[\w$]+\)\(\(0,[\w$]+\.[\w$]+\)\([\w$]+\),[\w$]+\),\.\.\.[\w$]+\}]],
    transforms = {
      {
        match = [[\(\(0,([\w$]+\.[\w$]+)\)\(([\w$]+)\),([\w$]+)\),\.\.\.([\w$]+)\}$]],
        replace = [[((0,\1)(\2),\3),...\4,children:(#{{self}}?.FriendBadge??((a,b)=>b))(\2,this.props.children)}]],
      },
    },
  },

  -- The game page's friends section reads who plays an app from Steam's CM, which has
  -- none for an Epic game, so game-page/friends.ts answers with Epic friends who do
  {
    file = [[sp\.js]],
    find = [[const\{data:[\w$]+\}=\(0,[\w$]+\.[\w$]+\)\([\w$]+,\{staleTime:36e5\}\);]],
    transforms = {
      {
        match = [[^const\{data:([\w$]+)\}=(\(0,[\w$]+\.[\w$]+\)\(([\w$]+),\{staleTime:36e5\}\));$]],
        replace = [[const \1=(#{{self}}?.FriendsWhoPlay??((a,b)=>b))(\3,\2.data);]],
      },
    },
  },

  -- "View all friends who play" opens Steam's community page for the app, which an Epic
  -- game doesn't have, so the section drops the link for one
  {
    file = [[sp\.js]],
    find = [["CommunityFriendsThatPlay",[\w$]+\),.*?primaryAction:\{action:[\w$]+,label:\(0,[\w$]+\.[\w$]+\)\("#AppDetails_Friends_ViewAll"\)\}]],
    transforms = {
      {
        match = [[^("CommunityFriendsThatPlay",([\w$]+)\),.*?primaryAction):]],
        replace = [[\1:#{{self}}?.IsEpicApp?.(\2)?void 0:]],
      },
    },
  },

  -- A friend's unlock in the feed hovers with when you unlocked it too, read from your
  -- achievements for the row's app, which for an Epic game's row Steam has none of
  {
    file = [[sp\.js]],
    find = [[for\(let [\w$]+ of Object\.values\([\w$]+\.data\.achieved\)\)]],
    transforms = {
      {
        match = [[Object\.values\(([\w$]+)\.data\.achieved\)]],
        replace = [[Object.values(\1.data?.achieved??{})]],
      },
    },
  },
}
