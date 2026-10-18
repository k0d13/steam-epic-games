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
}
