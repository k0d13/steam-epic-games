-- Edits Millennium makes to Steam's JavaScript as it serves it. `find` takes the
-- first match and `transforms` rewrite inside it; one that stops matching after a
-- Steam update is skipped. `#{{self}}` is our PLUGIN_LIST slot, which holds the
-- frontend entry's exports. There are no backreferences in a `find`, and a `` in a
-- `replace` mustn't be followed by a letter or digit, which would read as a longer group name

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

  -- General, Installed Files and DLC are only a Steam game's properties pages, so
  -- properties/installed-files.tsx swaps Shortcut for Steam's own General page and adds
  -- Installed Files and Steam's DLC page, spread into the push, which takes any number of
  -- items. General and DLC are taken from the Steam game's list further down
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

  -- "View DLC In Store" and the DLC tab's link build steam://url/StoreDlcPage/<appid>,
  -- which game-page/dlc.ts answers for an Epic game by opening Epic's page in the client
  {
    file = [[sp\.js]],
    find = [[BuildSteamURL\([\w$]+,\.\.\.[\w$]+\)\{return"steam://url/"]],
    transforms = {
      {
        match = [[BuildSteamURL\(([\w$]+),\.\.\.([\w$]+)\)\{return"steam://url/"]],
        replace = [[BuildSteamURL(\1,...\2){const epicGames=#{{self}}?.SteamURL?.(\1,\2);if(epicGames)return epicGames;return"steam://url/"]],
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

  -- The supernav menus, which store/menu.ts splits into Steam and Epic submenus when
  -- it's Store's. Steam's renderer for supernav entries is a sibling of the menu class, so
  -- it's named where the class's method can reach it, under a name no minified local shadows
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

  -- A shortcut's details page keeps only a few sections, so game-page/game-info.ts gets to
  -- put the info panel and Achievements back for an Epic game that has them. Anchored
  -- on the shortcut list, since BIsModOrShortcut is asked in other places too
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

  -- The info panel's developer, publisher and franchise names are bare anchors to
  -- steam://openurl/, which sends any page that isn't Steam's to the system browser, so
  -- services/epic/store.ts opens Epic's in the client instead
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

  -- The info panel (cover, description, developer, release date and features) draws
  -- a shortcut as a bare explanation, so for an Epic game with info, game-page/game-info.ts
  -- says it isn't one, as the panel reads its shortcut state at the top of render
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

  -- A shortcut's info panel starts open, as its only content was the explanation. An
  -- Epic game's starts as a Steam game's does, open for the games the user opened it
  -- on, and as it arrives after the page has drawn this can't wait for HasGameInfo
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

  -- The play bar's Cloud Status, and the status row that's its narrow form, which both
  -- bail for a shortcut before reading the details; game-page/cloud.ts fills those in for
  -- an Epic game whose saves it syncs, and leaves them saying there's no cloud otherwise
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

  -- The feed's "Say something about this game" box posts a status to friends, which can't
  -- say it's about an Epic game, as Steam's servers have no such app, so an Epic game's
  -- feed has no box
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

  -- Steam's artwork component, which draws every icon and capsule, so library/badge.ts
  -- can put the Epic mark in the container first. Its app, appid and asset type are
  -- read at the top of render, so the match carries everything up to the container
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

  -- The feed draws a friend's row from the friend store's answer for their account, and
  -- hides it unless they're a friend. game-page/friends.ts gives an Epic friend's
  -- stand-in account their name, a default avatar and a place among the friends
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

  -- A friend's name and avatar open their Steam profile, which a stand-in doesn't have,
  -- so game-page/friends.ts sends them to their Epic profile
  {
    file = [[sp\.js]],
    find = [[ResolveURL\([\w$]+,\.\.\.[\w$]+\)\{const [\w$]+=this\.m_steamUrls\[]],
    transforms = {
      {
        match = [[ResolveURL\(([\w$]+),\.\.\.([\w$]+)\)\{]],
        replace = [[ResolveURL(\1,...\2){const epicGames=#{{self}}?.ResolveURL?.(\1,\2);if(epicGames)return epicGames;]],
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
    find = [[[\w$]+=\(0,[\w$]+\.[\w$]+\)\("CommunityFriendsThatPlay",[\w$]+\),]],
    transforms = {
      {
        match = [[^([\w$]+=\(0,[\w$]+\.[\w$]+\)\("CommunityFriendsThatPlay",([\w$]+)\)),$]],
        replace = [[\1,epicGamesFriends=#{{self}}?.IsEpicApp?.(\2),]],
      },
    },
  },
  {
    file = [[sp\.js]],
    find = [[primaryAction:\{action:[\w$]+,label:\(0,[\w$]+\.we\)\("#AppDetails_Friends_ViewAll"\)\}]],
    transforms = {
      {
        match = [[primaryAction:(\{action:[\w$]+,label:\(0,[\w$]+\.we\)\("#AppDetails_Friends_ViewAll"\)\})]],
        replace = [[primaryAction:epicGamesFriends?void 0:\1]],
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
