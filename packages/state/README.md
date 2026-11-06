# @iirc/state

The one interpretation of what an Ircd says. `stepState` folds a Session's inbound Lines into Self, the Channels Self is in with their topics, modes, and members, the Users seen, and every `RPL_ISUPPORT` token, and names each change it made. Pure.

- **Depends on:** `@iirc/protocol`.
- **Used by:** `@iirc/session` (inside `Standing`), `@iirc/log` (Messages, Activity, and places), `apps/soak` (casefolding in the checker).
- **Lineage:** ircstates.

## Public surface

| Export | Role |
| --- | --- |
| `initialState`, `sessionState({ casemapping? })`, `IrcState` | A Session's state: `self`, `isupport`, `forcedCasemapping`, `channels`, and `users`. `sessionState` forces a mapping over the Ircd's (KNOW-3) |
| `stepState(state, line, at?)` | The state after one inbound Line, and its `StateChange`s. `at` dates a `TOPIC`. Never throws. Returns the same object when nothing changed |
| `StateChange` | Self: `Welcomed`, `NickChanged`, `SelfMaskChanged`, `SelfModesChanged`, `SelfAwayChanged`, `Joined`, `Parted`, `Kicked`, `JoinRefused`, `Forwarded`. Others: `MemberJoined`, `MemberParted`, `MemberKicked`, `UserQuit`, `UserRenamed`, `UserSeen`. Channels: `TopicChanged`, `ModesChanged`, `PrefixRemoved`, `NamesReplaced`, `ChannelRead`, `ChannelUncertain`. And `IsupportChanged` |
| `Self`, `Channel`, `Member`, `Topic`, `User`, `Isupport` | What each holds. A Channel's key is `modes.get("k")` |
| `channelOf`, `memberOf`, `userOf` | A Channel Self is in, a member of one, or a User seen, however each is spelled |
| `casemappingOf(state)` | The mapping in force: forced, or else the Ircd's |
| `casefold(casemapping, name)`, `mayFoldFurther` | The form names are compared in under `ascii`, `rfc1459`, `rfc1459-strict`, or `rfc8265` (KNOW-3), and whether a name folded under `ascii` could fold further |
| `SortedMap` | The persistent map members and Users are held in. A `ReadonlyMap` |
| `messageOf(line, sender?)` | The Message a `PRIVMSG` or `NOTICE` carries, if any |
| `nickOf(source)` | The nick in `nick!user@host`, `nick@host`, or a bare nick |
| `readsCommand(command)` | Whether `stepState` reads Lines of a command at all, so a host can skip the rest |
| `movesChannels(command)` | Whether Lines of a command can change which Channels Self is in, the mapping, or say a `JOIN` failed or Self was kicked, so a planner of joins can skip the rest, Messages included |
| Bounds | `heldChannels`, `membersPerChannel`, `heldMembers`, `usersPerGeneration`, `modesPerChannel`, `longestField`, `heldTokens` |
| `./modes`: `parseModes` | A Channel `MODE`'s letters against its parameters, by `PREFIX` and `CHANMODES` (KNOW-6) |
| `./place`: `placeOf`, `placeOfSent`, `Place`, `Placed` | The one place an inbound Line belongs, by MSG-2's rules in order, and the place of a Line Self sent, by its Target. Each from the state before the Line |
| `./place`: `channelPlace`, `userPlace`, `networkPlace`, `isUserMask` | A Channel's or a User's place, keyed by its name casefolded under the mapping in force and keeping its spelling (KNOW-3), the Network's own, and whether a source is a full `nick!user@host` |

## Usage

```ts
import { parseLine } from "@iirc/protocol/line";
import { channelOf, initialState, stepState } from "@iirc/state";

let state = initialState;

for (const text of [
  ":irc 001 me :Welcome",
  ":me!u@h JOIN #Foo[x]",
  ":irc 353 me = #Foo[x] :me @op",
  ":irc 366 me #Foo[x] :End of /NAMES list.",
  ":op!o@h MODE #foo{x} +k pizza",
]) {
  const parsed = parseLine(text);

  if (parsed._tag === "Line") {
    const { changes, next } = stepState(state, parsed.line);

    state = next;
    console.log(changes.map(({ _tag }) => _tag));
    // ["Welcomed"], ["Joined", "SelfMaskChanged"], [], ["NamesReplaced"], ["ModesChanged"]
  }
}

channelOf(state, "#FOO{X}")?.modes.get("k"); // "pizza", under rfc1459
channelOf(state, "#foo[x]")?.members.get("op"); // { nick: "op", prefixes: "o" }
```

## Key ideas

- **One Session at a time.** A new Connection starts again from `initialState`, or from `sessionState` with the same options. Nothing carries over (LIVE-6).
- **Feed it inbound Lines only.** Self's own outbound Lines must never move state, because only an Ircd says what is true (CONN-3). `Standing` keeps to this.
- **Changes are the interface.** A host acts on `changes`, such as a kick, a prefix removed, or a Channel gone uncertain, rather than diffing states. A `QUIT` or `NICK` names the Channels that held its User just before it, published or in a `NAMES` reply under way (KNOW-8). It names no Direct Message partner: placing one in that Timeline is the Log's fold, which knows the Timelines. `NamesReplaced`, `UserSeen`, and `ChannelRead` come from numerics, which are reads of state, not Activity, and a `353` names no change at all.
- **Users are remembered from what they are seen to do:** the source of a `JOIN`, `PRIVMSG`, or `NOTICE` that has a full `nick!user@host`, and `301`, `311`, and `352`. A `QUIT` forgets a User and a `NICK` moves them. Membership is the Channels' own, so a member whose `user@host` has been forgotten is still known by nick through `userOf`.
- **Names are kept as the Ircd last spelled them,** and keyed by their casefolded form under the mapping in force. A new mapping refolds Channels, members, and Users, and the later of two Channels that merge stands.
- **`RPL_ISUPPORT` is a map of tokens,** and every field beside it is read from that map, so `-TOKEN` brings back a default by removing the token, and nothing can disagree with it.
- **`353` to `366` is one replacement.** `353`s gather in the Channel's `pending`, and the `366` swaps them in. A `JOIN`, `PART`, `KICK`, `QUIT`, `NICK`, or prefix mode between them applies to both, so the swap loses nothing (KNOW-5).
- **Uncertain, not wrong.** A `MODE` that does not add up is kept raw in the Log and marks the Channel `modesUncertain` and `membersUncertain`. A `324` settles the first, and a `366` that nothing cut settles the second (KNOW-6). The member and mode bounds mark the same way. Each field that becomes uncertain is its own `ChannelUncertain`, naming `members` or `modes`, since each is read again by its own command.
- **A Line has one place, from the state before it (MSG-2).** `placeOf` reads only shape: Self, the welcome, `CHANTYPES`, `STATUSMSG`, the mapping, and the Line's source and first parameter, which is the Target of a `PRIVMSG`, `NOTICE`, or `INVITE`. Before the welcome, Target `*` or `AUTH`, or a source that is not `nick!user@host` is the Network's; then a Channel Target, its `STATUSMSG` prefix kept apart; then a `$` mask, the Network's; then a Line from Self, placed by its Target; then a Direct Message from its sender. A Line that names no Target, such as a `QUIT`, is placed through its changes, which name Channels, and that is the Log's to do.
- **Prefixes are ranked by the `PREFIX` in force,** and ranked again, published and pending alike, when it changes or is taken back. A letter `PREFIX` no longer names goes after the rest. A prefix mode on a nick that is not a member changes nothing.

## Data structure

A Channel's members and the Users seen are `SortedMap`s: persistent B+trees of nodes of up to 32 entries, keyed by casefolded nick. A change copies only the path to its key, so it costs the same in a Channel of 10 or 10,000, and each earlier state stays whole for the Log's fold. A `353` inserts its names as one batch that copies each node it touches once. There is no hash, so no choice of nicks can make a Network's members slow, and iteration is in key order on every run. The Channels themselves stay a copied `Map`, because there are at most 1024, the order they were joined in matters, and a copy costs about 5 µs.

### Fold measurements

Taken on fserv with Bun 1.4.4, by `bun packages/state/bench/fold.ts`: each Line through `stepState` alone, over repeated runs, collection pauses included.

| What                                                           | Measured              |
| -------------------------------------------------------------- | --------------------- |
| A 10,000 member `NAMES` burst, 199 Lines                       | 37 µs p50, 61 µs p99  |
| A netsplit: 5,000 `QUIT`s across 20 Channels of 2,000          | 13 µs p50, 32 µs p99  |
| The 5,000 rejoins after it                                     | 7 µs p50, 21 µs p99   |
| `JOIN` and `PART` in a 10,000 member Channel, beside 19 others | 5 µs p50, 15 µs p99   |
| 5,000 `QUIT`s with Self in 1,024 Channels, 20 shared           | 65 µs p50, 420 µs p99 |
| `PRIVMSG` from someone already seen as they are                | 1.2 µs p50, 3 µs p99  |
| `PRIVMSG` from someone new                                     | 3 µs p50, 9 µs p99    |
| One member into 10,000, with a copied `Map` instead            | 29 µs p50, 790 µs p99 |
| One member into 10,000 in a `SortedMap`                        | 3 µs p50              |

A `PRIVMSG` from someone seen as they are gives back the very same state, which is what lets the commonest Line cost so little. The largest single Line in any run took 1 to 4 ms, which looks like a collection pause rather than the fold. A `QUIT` or `NICK` looks in every Channel Self is in, about 60 ns each, so the 1,024 Channel row is the worst it gets. A reverse index from Users to Channels would make it constant, at the price of a second record to keep in step, and is not worth it until someone is in hundreds of busy Channels.

## Invariants

- Nothing held grows with what a Network sends (HOST-1). Each bound, and what happens at it:

| Bound | Value | At the bound |
| --- | --- | --- |
| Channels | 1024 | The oldest is dropped |
| Members of one Channel | 65,536, in its members and in a `NAMES` reply under way, each | No more are held. The members are `membersUncertain` at once, and a cut reply makes them so when its `366` swaps it in |
| Members of all Channels | 131,072, counting each Channel's members and its reply under way apart | The same. A Channel's old members and the reply replacing them both count until the swap, so the bound can stop short of full |
| Users seen | 2 generations of 32,768 | When the newer generation fills, the older is forgotten whole. Any sighting, changed or not, moves a User to the newer, so only a User not seen while 32,768 others were is at risk |
| Modes of one Channel | 64 letters | No new letter is held, and the Channel is `modesUncertain` |
| Self's user modes | 64 letters | No new letter is held |
| A nick, `user`, `host`, realname, or mode parameter | 255 UTF-16 units | A longer nick is not held as a member or a User, and the members become uncertain as above. A longer value is held as unknown, as a hidden key is |
| `RPL_ISUPPORT` tokens | 256 | A new token is not held, and `tokensDropped` says so. Tokens read into fields are always held |
| A topic | The Line's own, 8704 bytes (HOST-2) | Nothing more: 1024 of them are under 9 MB |

- A `JOIN`, `PART`, or `KICK` naming several Channels is several changes.
- A `JOIN` failure is a change and is not held, because only someone who asked knows whether it named a Channel (`437` also names nicks).
- A key shown as `*` is hidden: it leaves a known key as it was, and is otherwise held as unknown.
- `332`, `324`, `329`, `333`, `353`, and `366` change nothing for a Channel Self is not in, and a `JOIN` or `TOPIC` there names no change.
- Every change names a Channel as Self holds it, except `Joined` and `JoinRefused`, which name it as the Line did.

## Traps

- **An unknown mapping falls back to `ascii`,** which can only split names, and `isupport.unknownCasemapping` names the token. Ergo's `permissive` mode looks like `ascii` on the wire, which is why an Owner can force a mapping.
- **`rfc8265` is as close as JavaScript allows.** Width mapping covers the Halfwidth and Fullwidth Forms block and U+3000 by NFKC, lower-casing is `toLowerCase` with capital sigma always taken to `σ`, and NFC follows, four passes at most, as Ergo does. Unlike Ergo, it rejects nothing, and Go's width folding of a few characters outside that block, and its handling of the halfwidth voicing marks, may differ.
- **Without `multi-prefix`, `NAMES` shows only the highest prefix,** so a member with `@+` is held as `o`. Removing a prefix mode says `PrefixRemoved`, for a planner to schedule a `NAMES`.
- **List modes are not held.** A `MODE +b` flows through `ModesChanged`, and a ban list is a Lookup, so `modes` never grows with one.
- **The last parameter of a `005` is never read.** A `005` is its Target, its tokens, then text for people, and no text may change behaviour, so `:irc 005 me NETWORK=x :CASEMAPPING=ascii` changes no mapping. An Ircd that leaves the text out loses its last token: there is no telling the two apart without reading the text.
- **A `TOPIC` is dated only if its host passes `at`.** `Standing` passes the Entry's time. A `333` gives seconds, which are held as milliseconds.
- **`users.size` counts the older generation,** so it is for tests and status, not for every Line.
- `476` may carry no `<client>` parameter, as RFC 2812 gives it, so its Channel can come first.

## Requirements

[Network state](../../docs/requirements.md#network-state) and [Channels and Users](../../docs/requirements.md#channels-and-users) build here: KNOW-1's Self, KNOW-2, KNOW-3, KNOW-4, KNOW-6, and KNOW-7, and the state KNOW-5, KNOW-8, and KNOW-9 need. So does MSG-2's placement, in `./place`. It also serves CONN-3, LIVE-6, LIVE-7, LIVE-8, CRED-4, and HOST-1. `src/testdata/state.yaml` holds the conformance vectors.
