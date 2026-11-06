import { upperCaseAscii } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import { casefold } from "./casemapping.ts";
import { casemappingOf, nickOf } from "./state.ts";
import type { IrcState } from "./state.ts";

/**
 * Where a Line belongs: the Network's Timeline, a Channel's, or a Direct Message partner's
 * (MSG-2). A Channel or a User is identified by `key`, its name casefolded under the
 * mapping in force at that Entry (KNOW-3), and keeps `name`, its spelling, for display.
 */
export type Place =
  | { readonly _tag: "Network" }
  | { readonly _tag: "Channel"; readonly key: string; readonly name: string }
  | { readonly _tag: "User"; readonly key: string; readonly name: string };

/** A Line's place, and the `STATUSMSG` prefix its Channel Target carried, if any. */
export interface Placed {
  readonly place: Place;
  /** Such as `@` for a Message to `@#chan`, which belongs to `#chan` (MSG-2). */
  readonly statusmsg: string | undefined;
}

/** The Network's own Timeline. */
export const networkPlace: Place = { _tag: "Network" };

const onNetwork: Placed = { place: networkPlace, statusmsg: undefined };

/**
 * A Channel's place, under the mapping in force.
 * @param state - The Session's state at that Entry.
 * @param name - The Channel, spelled as it is to be shown.
 * @returns Its place.
 */
export const channelPlace = (
  state: IrcState,
  name: string
): Extract<Place, { readonly _tag: "Channel" }> => ({
  _tag: "Channel",
  key: casefold(casemappingOf(state), name),
  name,
});

/**
 * A Direct Message partner's place, under the mapping in force.
 * @param state - The Session's state at that Entry.
 * @param nick - The partner, spelled as they are to be shown.
 * @returns Their place.
 */
export const userPlace = (
  state: IrcState,
  nick: string
): Extract<Place, { readonly _tag: "User" }> => ({
  _tag: "User",
  key: casefold(casemappingOf(state), nick),
  name: nick,
});

/**
 * Whether a Line's source is a User's full `nick!user@host`, and not an Ircd's name or a
 * bare nick, which is all that can say a Line came from a User.
 * @param source - A Line's source, if it has one.
 * @returns Whether it names a User in full.
 */
export const isUserMask = (source: string | undefined): source is string => {
  const bang = source?.indexOf("!") ?? -1;

  return source !== undefined && bang > 0 && source.includes("@", bang);
};

// A Channel Target, with any `STATUSMSG` prefix taken off and kept. A prefix comes first:
// where `&` is both, `&#chan` is `#chan` for its `&` members. So the longest run of
// `STATUSMSG` characters that leaves a Channel name by `CHANTYPES` is the prefix, and only a
// Target with no such run is a Channel as it stands, such as `&local` (MSG-2).
const channelTarget = (
  { isupport: { chantypes, statusmsg } }: IrcState,
  target: string
): { readonly name: string; readonly statusmsg: string | undefined } | undefined => {
  let prefixed: number | undefined;

  for (let length = 1; length < target.length; length += 1) {
    if (!statusmsg.includes(target.charAt(length - 1))) {
      break;
    }

    prefixed = chantypes.includes(target.charAt(length)) ? length : prefixed;
  }

  if (prefixed !== undefined) {
    return { name: target.slice(prefixed), statusmsg: target.slice(0, prefixed) };
  }

  return target !== "" && chantypes.includes(target.charAt(0))
    ? { name: target, statusmsg: undefined }
    : undefined;
};

// What a Target names, once it is known that it is not the Network's by whoever sent it.
const byTarget = (state: IrcState, target: string, other: () => Place): Placed => {
  const channel = channelTarget(state, target);

  if (channel !== undefined) {
    return { place: channelPlace(state, channel.name), statusmsg: channel.statusmsg };
  }

  return target.startsWith("$") ? onNetwork : { place: other(), statusmsg: undefined };
};

const isSelf = (state: IrcState, nick: string) =>
  state.self !== undefined &&
  casefold(casemappingOf(state), nick) === casefold(casemappingOf(state), state.self.nick);

/**
 * The one place an inbound Line belongs, by MSG-2's rules in order. Its Target is its
 * first parameter, as a `PRIVMSG`, `NOTICE`, or `INVITE` has it. Decided from the Line's
 * shape and the state before it, never from its words. Pure, and never throws.
 *
 * 1. Before the welcome, with Target `*` or `AUTH`, or with no source or one that is not
 *    `nick!user@host`: the Network, so an Ircd's notices never become Direct Messages.
 * 2. A Channel Target, after any `STATUSMSG` prefix: that Channel, the prefix kept apart.
 * 3. A `$` mask: the Network.
 * 4. Sourced from Self, as another session of Self's account can be: Self's Message to its
 *    Target, placed as an outbound one is.
 * 5. Any other Target: a Direct Message from its sender, even one not addressed to Self.
 * @param state - The Session's state just before the Line, which gives Self, `CHANTYPES`,
 * `STATUSMSG`, the mapping, and whether the Session is welcomed.
 * @param line - The inbound Line.
 * @returns Its place.
 */
export const placeOf = (state: IrcState, line: Line): Placed => {
  const [target = ""] = line.params;
  const { source } = line;

  if (
    state.self === undefined ||
    target === "" ||
    target === "*" ||
    upperCaseAscii(target) === "AUTH" ||
    !isUserMask(source)
  ) {
    return onNetwork;
  }

  const sender = nickOf(source) ?? "";

  return byTarget(state, target, () => userPlace(state, isSelf(state, sender) ? target : sender));
};

/**
 * The place of a Line Self sent, which is its Target's: a Channel, a `$` mask's Network,
 * or else the User it went to (MSG-2).
 * @param state - The Session's state when it was sent.
 * @param line - The outbound Line, whose first parameter is its Target.
 * @returns Its place.
 */
export const placeOfSent = (state: IrcState, line: Line): Placed => {
  const [target = ""] = line.params;

  return target === "" ? onNetwork : byTarget(state, target, () => userPlace(state, target));
};
