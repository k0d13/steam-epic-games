-- Edits Millennium makes to Steam's JavaScript as it serves it. `find` takes the
-- first match and `transforms` rewrite inside it; one that stops matching after a
-- Steam update is skipped. `#{{self}}` is our PLUGIN_LIST slot, which holds the
-- frontend entry's exports.

return {
  -- Manage has no Uninstall or Cancel for shortcuts, so manage-menu.ts adds them to
  -- what Steam built. Steam's own menu while the frontend isn't there.
  {
    file = [[sp\.js]],
    find = [[this\.BuildManageSubmenu\(([\w$]+),([\w$]+),([\w$]+)\)]],
    transforms = {
      {
        match = [[this\.BuildManageSubmenu\(([\w$]+),([\w$]+),([\w$]+)\)]],
        replace = [[(#{{self}}?.ManageSubmenu??(m=>m))(this.BuildManageSubmenu(\1,\2,\3),\1)]],
      },
    },
  },

  -- The supernav menus, which store-menu.ts splits into Steam and Epic submenus when
  -- it's Store's. Steam's renderer for supernav entries is a sibling of the menu
  -- class, so the first transform names it where the second can reach it.
  {
    file = [[sp\.js]],
    find = [[const [\w$]+=[\w$]+=>\{const\{disabledItemClass:[\w$]+,menuItems:[\w$]+,children:[\w$]+\}=.*?\.CreateContextMenuInstance\([^}]*\}\),[^{}]*\{[^}]*\}\)]],
    transforms = {
      {
        match = [[const ([\w$]+)=([\w$]+)=>\{const\{disabledItemClass:]],
        replace = [[const epicGamesSupernavItems=()=>\1,\1=\2=>{const{disabledItemClass:]],
      },
      {
        match = [[\.CreateContextMenuInstance\((\(0,[\w$]+\.jsx\)\([\w$]+,\{refContextMenu:([\w$]+),[^}]*\}\)),([^{}]*\{[^}]*title:([\w$]+),[^}]*\})\)]],
        replace = [[.CreateContextMenuInstance((#{{self}}?.SupernavMenu??(m=>m))(\1,\4,\2,epicGamesSupernavItems),\3)]],
      },
    },
  },

  -- Epic's pages in Steam's browser light the Store tab, rather than keeping
  -- whichever was last.
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

  -- A shortcut's details page keeps only a few sections, so game-info.ts gets to
  -- put the info panel and Achievements back for an Epic game that has them. Anchored
  -- on the shortcut list, since BIsModOrShortcut is asked in other places too.
  {
    file = [[sp\.js]],
    find = [[\["nonsteam","notes","screenshots"\];.*?\.BIsModOrShortcut\(\)&&\([\w$]+=[\w$]+\)]],
    transforms = {
      {
        match = [[([\w$]+)\.BIsModOrShortcut\(\)&&\(([\w$]+)=([\w$]+)\)]],
        replace = [[\1.BIsModOrShortcut()&&(\2=(#{{self}}?.ShortcutSections?.(\1,\3)??\3))]],
      },
    },
  },

  -- The info panel (cover, description, developer, release date and features) draws
  -- a shortcut as a bare explanation, so for an Epic game with info, game-info.ts
  -- says it isn't one. The panel reads its shortcut state at the top of render.
  {
    file = [[sp\.js]],
    find = [[let [\w$]+=this\.props\.overview\.BIsModOrShortcut\(\),[\w$]+=![\w$]+&&[\w$]+\.H\.GetAssociations\(]],
    transforms = {
      {
        match = [[=this\.props\.overview\.BIsModOrShortcut\(\),]],
        replace = [[=this.props.overview.BIsModOrShortcut()&&!#{{self}}?.HasGameInfo?.(this.props.overview),]],
      },
    },
  },

  -- A shortcut's info panel starts open, as its only content was the explanation. An
  -- Epic game's starts as a Steam game's does, open for the games the user opened it
  -- on, and it arrives after the page has drawn, so this can't wait for HasGameInfo.
  {
    file = [[sp\.js]],
    find = [[this\.state=\{bShowGameInfo:[\w$]+\.overview\.BIsModOrShortcut\(\)\|\|[\w$]+\.s_setGameInfoVisible\.has\(this\.props\.overview\.appid\),suppressTransition]],
    transforms = {
      {
        match = [[bShowGameInfo:([\w$]+)\.overview\.BIsModOrShortcut\(\)\|\|]],
        replace = [[bShowGameInfo:\1.overview.BIsModOrShortcut()&&!#{{self}}?.IsEpicGame?.(\1.overview)||]],
      },
    },
  },

  -- The play bar's button that opens the info panel, which a shortcut doesn't get.
  {
    file = [[sp\.js]],
    find = [[![\w$]+\.BIsModOrShortcut\(\)&&\(0,[\w$]+\.jsx\)\([\w$]+\.[\w$]+,\{direction:"bottom",className:\(0,[\w$]+\.A\)\([\w$]+\(\)\.MenuButton,this\.props\.bShowInfoExpanded]],
    transforms = {
      {
        match = [[!([\w$]+)\.BIsModOrShortcut\(\)&&]],
        replace = [[(!\1.BIsModOrShortcut()||#{{self}}?.HasGameInfo?.(\1))&&]],
      },
    },
  },

  -- The full achievements page's store, whose three getters ask achievements.ts
  -- first, so an Epic game's page isn't Steam's cached "Failed to retrieve user stats".
  {
    file = [[sp\.js]],
    find = [[GetPlayerAchievements\([\w$]+,[\w$]+\)\{if\(.*?GetGlobalAchievements\([\w$]+\)\{]],
    transforms = {
      {
        match = [[(GetMyAchievements|GetGlobalAchievements|GetPlayerAchievements)\(([\w$]+)(,[\w$]+)?\)\{]],
        replace = [[\1(\2\3){const epicGames=#{{self}}?.AchievementStore?.("\1",\2);if(epicGames)return epicGames;]],
      },
    },
  },

  -- Steam's artwork component, which draws every icon and capsule, so library-badge.ts
  -- can put the Epic mark in the container first. Its app, appid and asset type are
  -- read at the top of render, so the match carries everything up to the container.
  {
    file = [[sp\.js]],
    find = [[render\(\)\{let\{app:[\w$]+,appid:[\w$]+,appinfo:[\w$]+,className:[\w$]+,rgSources:.*?return\(0,[\w$]+\.jsxs\)\("div",\{className:[\w$]+,children:\[]],
    transforms = {
      {
        match = [[(render\(\)\{let\{app:([\w$]+),appid:([\w$]+),.*?eAssetType:([\w$]+),.*?children:\[)$]],
        replace = [[\1(#{{self}}?.LibraryBadge?.(\2?.appid??\3,\4)),]],
      },
    },
  },
}
