import { useSyncExternalStore } from "react";
import { EPIC_STORE } from "../../services/epic/store";
import { hashId } from "../../state/app-ids";
import * as friendAchievements from "../../state/game/friend-achievements";
import * as library from "../../state/library";

// The feed and friends section only draw friends the friend store knows, so each Epic friend gets a
// stand-in SteamID no real account uses, and backend/patches.lua routes their lookups through here

// The SteamID64 of account 0 in the public universe
const ACCOUNT_ZERO = BigInt("76561197960265728");

// Steam hands out account ids from 1 and is far from the top of this half
const STAND_IN_FLOOR = 0xf0000000;
const STAND_IN_SPAN = 0x10000000;

interface StandIn {
  epicId: string;
  name: string;
  steamId: string;
  avatar: string;
}

const byAccount = new Map<number, StandIn>();
const bySteamId = new Map<string, StandIn>();
const byEpicId = new Map<string, number>();

// What the friend store answers with, which we wrap and Steam's code keeps reading from
const states = new WeakMap<object, { avatar: string; name: string; state: object }>();

// What we've wrapped, which Steam's components are asked about by identity
const wrappedPersonas = new WeakSet<object>();

// Epic has no profile pictures: it draws the name's first letter in white on a color it
// picks and sends with the avatar's address, which is all we get of its choice
const FALLBACK_COLOR = "#555555";

function letterAvatar(name: string, color: string | null | undefined) {
  const letter = name.match(/[a-zA-Z]/)?.[0].toUpperCase() ?? "?";
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    `<rect width='64' height='64' fill='${color ? `#${color}` : FALLBACK_COLOR}'/>` +
    "<text x='32' y='32' text-anchor='middle' dominant-baseline='central' " +
    `font-family='sans-serif' font-size='34' fill='white'>${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function accountFor(epicId: string) {
  const known = byEpicId.get(epicId);
  if (known !== undefined) return known;

  let account = STAND_IN_FLOOR + (hashId(epicId) % STAND_IN_SPAN);
  while (byAccount.has(account)) account = STAND_IN_FLOOR + ((account + 1) % STAND_IN_SPAN);

  byEpicId.set(epicId, account);
  return account;
}

// The SteamID64 the feed attributes a friend's rows to
export function standIn(friend: { id: string; name: string; color?: string | null }) {
  const account = accountFor(friend.id);
  const avatar = letterAvatar(friend.name, friend.color);
  let entry = byAccount.get(account);

  if (!entry) {
    const steamId = String(ACCOUNT_ZERO + BigInt(account));
    entry = { epicId: friend.id, name: friend.name, steamId, avatar };
    byAccount.set(account, entry);
    bySteamId.set(steamId, entry);
  }

  entry.name = friend.name;
  entry.avatar = avatar;
  return entry.steamId;
}

// Steam freezes these, which a Proxy may not answer differently for, so the values shadow
// the real object from one that inherits the rest of it
function override<T extends object>(target: T, values: Record<string, unknown>) {
  const shadow = Object.create(target) as T;
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(shadow, key, { value, enumerable: true });
  }
  return shadow;
}

// The friend store's answer for an account, which for a stand-in is its unknown player
// made a ready friend with the Epic name and Steam's default avatar
export function FriendState(account: number, state: object) {
  const friend = byAccount.get(account);
  if (!friend) return state;

  const saved = states.get(state);
  if (saved?.name === friend.name && saved.avatar === friend.avatar) return saved.state;

  // Steam says "Offline" for a persona it has no state for, and its mini profile asks the
  // community for a level, so the hover is fed a blank status and no profile data to load
  const persona = override(Reflect.get(state, "persona") as object, {
    m_strPlayerName: friend.name,
    avatar_url: friend.avatar,
    avatar_url_medium: friend.avatar,
    avatar_url_full: friend.avatar,
    GetLocalizedOnlineStatus: () => "",
  });
  const wrapped = override(state, {
    is_friend: true,
    is_blocked: false,
    is_ready: true,
    display_name: friend.name,
    nickname: "",
    persona,
    miniProfileData: { EnsureCommunityDataLoaded() {} },
  });

  states.set(state, { avatar: friend.avatar, name: friend.name, state: wrapped });
  wrappedPersonas.add(persona);
  return wrapped;
}

export function isEpicPersona(persona: object | undefined) {
  return !!persona && wrappedPersonas.has(persona);
}

// A name or avatar opens a Steam profile, which a stand-in doesn't have, so it's their
// Epic profile instead
export function ResolveURL(name: string, values: unknown[]) {
  if (name !== "SteamIDPage") return undefined;

  const friend = bySteamId.get(String(values[0]));
  return friend && `${EPIC_STORE}/u/${friend.epicId}`;
}

// What Steam's friends section reads for a game, by SteamID; Epic keeps friends' play time to
// themselves, so there's none, and only an Epic game gets stand-ins
interface FriendsWhoPlayData {
  in_game: never[];
  played_recently: never[];
  played_ever: { steamid: string; minutes_played: number; minutes_played_forever: number }[];
  in_wishlist: never[];
  owns: never[];
}

const sections = new WeakMap<FriendAchievements, FriendsWhoPlayData>();

// Called every render by Steam's hook, so it holds a hook of its own, always
export function FriendsWhoPlay(appId: number, data: unknown) {
  const game = library.getByAppId(appId);
  const played = useSyncExternalStore(friendAchievements.subscribe, () =>
    game ? friendAchievements.get(game.app_name) : undefined,
  );
  if (!game) return data;

  friendAchievements.ensure(game.app_name);
  if (!played) return data;

  let section = sections.get(played);
  if (!section) {
    // Lua sends {} for an empty list
    section = {
      in_game: [],
      played_recently: [],
      played_ever: Object.values(played.friends).map((friend) => ({
        steamid: standIn(friend),
        minutes_played: 0,
        minutes_played_forever: 0,
      })),
      in_wishlist: [],
      owns: [],
    };
    sections.set(played, section);
  }

  return section;
}
