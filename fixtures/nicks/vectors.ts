/**
 * Conformance vectors for reading a nick, as plain data: what the Client's `parseNick`
 * says of each name under the Network's rules, and where the web frontend's `isLookupNick`
 * says otherwise on purpose, why. The Client's tests and the frontend's both run every one,
 * so the rules the frontend copies cannot drift from the Client's unseen.
 *
 * @packageDocumentation
 */

/** One name, the Network's rules, and what each reader says of it. */
export interface NickVector {
  readonly name: string;
  /** `CHANTYPES` in force. */
  readonly chantypes: string;
  /** The symbols of `PREFIX` in force. */
  readonly prefixes: string;
  /** `STATUSMSG` in force, `""` for none. */
  readonly statusmsg: string;
  /** Whether the Client reads it as a nick. */
  readonly nick: boolean;
  /** Where the frontend says otherwise on purpose: what it says, and why. */
  readonly frontend?: { readonly nick: boolean; readonly why: string };
}

/** What the Client assumes before an Ircd says: `CHANTYPES` `#&`, `PREFIX` `(ov)@+`, no `STATUSMSG`. */
const floor = { chantypes: "#&", prefixes: "@+", statusmsg: "" } as const;

const noStatusmsg =
  "No route gives a Frontend STATUSMSG, so it reads a nick as the Client does given none; the Client refuses this one as Unsendable, which the card says.";

const noLine = "No Line can carry it, and the API refuses it before the Client reads a nick.";

export const nickVectors: readonly NickVector[] = [
  { ...floor, name: "peer", nick: true },
  { ...floor, name: "[bob]", nick: true },
  { ...floor, name: "{bob}|away", nick: true },
  { ...floor, name: "ped-ant_", nick: true },
  { ...floor, name: "é", nick: true },
  // A dotted name is a nick: the Ircd decides what it names.
  { ...floor, name: "irc.example.com", nick: true },
  // Only U+0020 is a space to the Client, so a tab or a no-break space is part of a nick.
  { ...floor, name: "pe\ter", nick: true },
  { ...floor, name: "pe er", nick: true },
  { ...floor, name: "pe#er", nick: true },
  { ...floor, name: "", nick: false },
  { ...floor, name: "pe er", nick: false },
  { ...floor, name: "a,b", nick: false },
  { ...floor, name: "*", nick: false },
  { ...floor, name: "pe?r", nick: false },
  { ...floor, name: "nick!user", nick: false },
  { ...floor, name: "nick@host", nick: false },
  { ...floor, name: "$*.test", nick: false },
  { ...floor, name: ":peer", nick: false },
  { ...floor, name: "#iirc", nick: false },
  { ...floor, name: "&local", nick: false },
  { ...floor, name: "@peer", nick: false },
  { ...floor, name: "+peer", nick: false },
  // `+` is neither a Channel's start nor a rank's symbol here.
  { chantypes: "#&", name: "+peer", nick: true, prefixes: "@", statusmsg: "" },
  { chantypes: "#", name: "&local", nick: true, prefixes: "@+", statusmsg: "" },
  { chantypes: "#&", name: "~peer", nick: false, prefixes: "~&@%+", statusmsg: "" },
  {
    chantypes: "#&",
    frontend: { nick: true, why: noStatusmsg },
    name: "%peer",
    nick: false,
    prefixes: "@+",
    statusmsg: "%",
  },
  { ...floor, frontend: { nick: false, why: noLine }, name: "pe\0er", nick: true },
  { ...floor, frontend: { nick: false, why: noLine }, name: "pe\r\ner", nick: true },
];
