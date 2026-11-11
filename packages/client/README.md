# @iirc/client

The pure IRC client for one Network. It does no I/O and reads no clock. Every input carries its time, and every effect leaves as an output, so the same inputs always give the same states and outputs.

This README is the module's written interface. The types are in `src/`, and [the architecture](../../docs/architecture.md#inside-the-client) says where it fits. The Client is `client`, exported from `@iirc/client`. Its machines are reducers ([ADR 0009](../../docs/adr/0009-client-machines-are-reducers.md)): the Network and its Connection, cap negotiation, Presence, the keepalive, and a keyed `Map` of Channels, as [the statecharts](../../docs/architecture.md#machines) draw them. [Features](#features) lists what it does, from the floor up.

## Callers

| Caller | Uses | Imports |
| --- | --- | --- |
| The Runtime | `client.step` for each input, then carries out the outputs and journals both | `@iirc/client` |
| Views | `known` for what is known, `channel` for one Channel alone, and News for Timelines | `@iirc/client/known`, and News from `@iirc/client` |
| Scenario tests | inputs in, outputs and News out, with a fake clock | `@iirc/client/testing` |
| Agents and debugging | `inspect` for machine states, caps, Features, and timers | `@iirc/client` |

```ts
interface Client<State> {
  readonly initial: State;
  readonly step: (state: State, input: Input) => Step<State>; // { state, outputs, news }
  readonly known: (state: State) => Knowledge;
  readonly channel: (state: State, name: string) => ChannelView | undefined;
  readonly inspect: (state: State) => Inspection;
}
```

`State` is opaque. It must be serialisable, or rebuilt by replaying the Journal.

## Inputs

Each input carries `at`, the instant it happened as the Runtime saw it.

| Input | From | Meaning |
| --- | --- | --- |
| `Started` | Runtime | The Runtime has started. A Connection the Client believed open is over. |
| `Configured` | Owner | The Network's whole Configuration. Joining, parting, and quitting are changes to it. |
| `Say` | Owner | Say something to a Target, with an intent id from the Runtime. |
| `Act` | Owner | Act on the Network, with an intent id from the Runtime: set a topic, kick, change modes, invite, change Self's nick, be away or back, or send a Line written as text. [Acting](#acting) says how each is sent. |
| `Retry` | Owner | Try connecting now, cutting a wait short. |
| `Read` | Owner | The Owner has read a Timeline up to the instant `read`: a Target's, named as a `Say`'s is, or with `target` null, the Network's own. |
| `Opened` | Transport | A Connection the Client dialled is open. |
| `Received` | Transport | One Line's bytes, without its line ending. |
| `Closed` | Transport | A Connection is over, and how. |
| `Fired` | Clock | A timer the Client set is due, with the instant its `Wake` set. It consumes the timer. |
| `Unfilled` | Runtime | A `SendSecret` could not be filled, so nothing was sent: the Credential is `Missing`, the Vault is `Unavailable`, or the value is `Unsendable` in that Line, such as a password with a line break. |
| `Unsent` | Runtime | `Send` and `SendSecret` outputs on a Connection that never left, as they were output and in that order: the Runtime's queue dropped them because the Connection ended, or its hang-up ran out of time. |
| `Stopping` | Runtime | The Runtime is shutting down. |

`NetworkConfiguration` is the Schema of what `Configured` carries, exported from `@iirc/client` and alone from `@iirc/client/configuration`, which is pure data a Frontend may import. Each field has a `description`, and says what a new Network starts with: Effect's `default` annotation for a fixed value (`channels`, `declined`, and `highlights` none, `enabled` on, `login` `None`, `fallbackEncoding` `windows-1252`, a SASL login's `required` off), `startsAsFirstNick` for `realname`, `username`, and a SASL `account`, and nothing for `ircds` and `nicks`, which must be given. `IrcdAddress` carries that identifier, and every field typed `CredentialName`, `password`, a SASL login's `credential`, and a Channel's `key`, carries `CredentialName`'s. So a Frontend derives every option from the Schema alone ([ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md)), and a field added here is an option there with no other work. A field added after Journals were written with `Configured` inputs without it decodes those as its default, as `highlights` does, with `optionalKey` on the encoded side and a decoding to the value, so a Journal written before it still replays, with no new Journal version.

When the Client dials:

- A `Configured` or `Started` with the Network enabled dials at once, if no Connection is open and none is waiting to be redialled. There is no backoff before a first dial.
- Backoff applies only to redialling after a `Closed`. A `Configured` while waiting keeps waiting, and `Retry` cuts the wait short.
- A `Configured` that disables the Network while a Connection is open sends `QUIT` if registration has begun, hangs up, and the Client waits for its `Closed`. Enabled again before that `Closed`, it dials as soon as the `Closed` arrives.
- A `Started` ends the Connection the Client believed open, with `Restarted`, and dials at once.
- A `Stopping` shuts the gate: the Client says `QUIT` on its Connection if registration has begun, hangs it up, and its Session ends `Closed` `HungUp` when the `Closed` comes. A wait to redial ends. Until the next `Started`, it dials nothing, whatever a `Configured`, `Retry`, or `Fired` asks, and refuses every `Say` with `Offline`. With no Connection, a `Stopping` only shuts the gate. The next `Started` dials at once if the Network is enabled.
- Each dial takes the next Ircd in `ircds`, round and round, except an STS upgrade, which dials the same host again over TLS, at once.
- While an STS policy holds for a dial's host, the dial is TLS on the policy's port, whatever Configuration says.

## Outputs

| Output | Meaning |
| --- | --- |
| `Dial` | Open a Connection to an Ircd, numbered by the Client. While an STS policy holds for the host, the address is TLS on the policy's port, whatever Configuration says. |
| `Send` | Send an `OutboundLine`. It counts as sent unless an `Unsent` input says otherwise. Every Line of a `Say` or an `Act` carries its `intent`, and no other Line does. |
| `SendSecret` | Send a `SecretLine`. The Runtime fills in the Credential with `fillSecret` from `@iirc/protocol`. |
| `Hangup` | End a Connection. The Client still waits for its `Closed`. |
| `Wake` | Set a timer to an instant, or cancel it with `null`. The same id replaces the earlier one. |

Connection ids start at 1 and go up by 1 for each `Dial`. They are never reused, and replaying the Journal rebuilds them.

Timers are one-shot. The timer table is a projection of the Journal's inputs and outputs: `timers(table, input, outputs)` folds one step. A `Fired` whose `due` matches the table consumes its timer, and then the last `Wake` for each id sets it, so the Client re-arms a timer with a fresh `Wake` if it wants it again. A stale `Fired` changes nothing. The Runtime folds it over every step while replaying, then sets every timer in it.

The Client's timers, by id:

| Timer | Set while | When it fires |
| --- | --- | --- |
| `redial` | waiting after a `Closed` | dials the next Ircd |
| `register` | registering, 60 s from `Opened` | hangs up: the Connection ends `Silent` |
| `hold` | a Feature holds registration, 30 s from when it began | asks each holding Feature's `expired` |
| `keepalive` | in a Session | a lag `PING` after 60 s with nothing heard, and a hang-up after 90 s |
| `rejoin <channel>` | a Channel is refused or kicked, with its folded name | joins it again |

The State holds no timer table. Each machine's state names the instants it waits for, the table is derived from them, and `inspect` shows it.

## News

News is what happened in one step, in order. It is derived, so replaying the Journal makes it again, and it is never journaled.

| News | Meaning |
| --- | --- |
| `Message` | Something said, with its time, id, client-only tags, whether it is `live`, whether it is a `highlight`, whether Self said it (`self`), and `where` it belongs. One we said carries `ours`: its intent id, and whether the Ircd will echo it. |
| `Confirmed` | The Ircd echoed back the Message for an intent, with its own time, id, and final text. |
| `Activity` | Something that changed, with its time, id, whether it is `live`, and `where` it belongs. |
| `SessionBegan`, `SessionEnded` | A Session's start and end, and why it ended. |
| `ConnectionFailed` | A Connection that ended before registration, and why. |
| `Refolded` | An Ircd declared a casemapping other than the one the Network last declared, or other than `rfc1459` when none was, so keys in `where` fold by it from here on. |
| `ReadMarker` | The Owner's Read Marker of a Timeline moved forward, to `read`, with `where` it belongs: `Network`, `Channel`, or `Direct` with `existing`. |
| `Refused` | An Owner intent, a `Say` or an `Act`, that was not carried out, with its intent id: `Offline`, `Unsendable`, `Rejected` by the Ircd's reply tied to it, with the numeric or code, or `Unsent`: at least part of it never left, because its Connection ended first. One for an `Act` carries `action`: what it tried and where it belongs, as [Where News belongs](#where-news-belongs) says. |
| `Ignored` | An input that changed nothing, and why. |

Three rules for Timelines, which [`@iirc/timelines`](../timelines/README.md) folds News by:

- **Our own Messages.** A Message we say appears as News when we send it. If `ours.echo` is set, a `Confirmed` for its intent follows when the Ircd echoes it, and the echo is not a second Message. With no echo, it stays unconfirmed: sent, with delivery unknown. If its Line never left, a `Refused` `Unsent` for its intent follows instead, unless the Ircd had already confirmed it on that Connection, so a Timeline marks the Message as not sent.
- **Order by time.** History arrives late, with `live` false. A Timeline orders by `at`, not by when the News came.
- **One per id.** A Message can arrive live and again from history. A Timeline keeps one per id. One with an unknown id is kept as it came.
- **Self's own.** A Message is `self` when Self said it, by the source, as a Highlight is judged: ours, Self's echo, or Self said elsewhere, as from another IRC client, live or from history. Ours is always `self`, and a Message that is `self` is never a `highlight`. A projection counts none of them as unread.

### Where News belongs

Each Message and Activity carries `where`: the Timelines it touches, never none, in a fixed order ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)). The Client works it out from what it knows as the step begins, before the step changes anything, so a projection can fold News into Timelines without knowing the casemapping, Self's nick, or who shares which Channel. Keys are names folded with the casemapping the Network last declared, and each comes with the name as it was said, to show.

| `where` | The Timeline |
| --- | --- |
| `Network` | The Network's own. |
| `Channel { key, name }` | A Channel's. |
| `Direct { key, name, existing }` | A Direct Message partner's, the other participant, never Self unless Self is both. With `existing`, it touches only a Timeline that already exists and never starts one. |
| `DirectRenamed { key, name, to }` | A Direct Message partner changed nick. It touches only a Timeline that already exists, keyed `key`, which takes the item and is keyed and named by `to` from then on. |

The rules, each decided from commands, parameters, `CHANTYPES`, `PREFIX`, and `STATUSMSG`, never from text. Names are read by one parser, in `src/names.ts`, whichever way a Line goes, so both directions of a Direct Message always agree:

- A **Channel's name** starts with a character of `CHANTYPES`, and holds no space, BELL, or `,`.
- A **nick** holds no space, `,`, `*`, `?`, `!`, or `@`, and does not start with `$`, `:`, a character of `CHANTYPES`, or a membership prefix of `PREFIX` or `STATUSMSG`. Anything else may appear inside one, so `a$b`, `a#b`, and `first.last` are nicks, and with `PREFIX=(ov)@+`, `+peer` is not. Modern IRC says a nick should not hold a `.`, and does not forbid it, so a name alone is a nick with one. Telling a User from a server is done with the source, below.
- **A Target may be a list**, such as `#a,#b`. Each item is placed by itself, empty items name nothing, and each Timeline is listed once, the first kept. A list is never one Timeline. An Owner's `Say` names one Target, since `@iirc/protocol` builds no `PRIVMSG` or `NOTICE` to a list, so a `Say` to one is `Refused` as `Unsendable`.
- **A Message to a Channel** belongs to the Channel, whoever said it, the Ircd included. A Target is a Channel by its name, or after any `STATUSMSG` prefixes it starts with, so `@#iirc` belongs to `#iirc`. A name that is already a Channel's is one, and prefixes are stripped only while what is left is not, so with `CHANTYPES=#&` and `STATUSMSG=~&@%+`, `&local` and `&#other` are those Channels, and `@&local` is `&local`. With no `STATUSMSG`, `@#iirc` names no Channel.
- **A Direct Message** belongs to the other participant: to Self from a User, the sender's; from Self to a User, the Target's, whether we said it, its echo, or Self said it from elsewhere. A Message from Self to Self is Self's. The Target must be a nick, and so must the sender's name. A source is a User when it has a user or a host, whatever its name holds, or a bare name that is not the Ircd's and has no `.`. A bare name with a `.`, or the Ircd's own name from `001` in any ASCII case, since it is a host name, is a server.
- **Any other Message** belongs to the Network: one from the Ircd or another server that is not to a Channel, one to a mask such as `$*`, one to `*` before registration, one to a User other than Self from someone other than Self, or one whose sender or Target is not a nick.
- **`Joined`, `Parted`, `Kicked`, and `TopicChanged`** belong to their Channel. A `JOIN`, `PART`, `KICK`, or `TOPIC` whose Channel parameter is not a Channel's name, or a `JOIN` or `PART` with any item of its list not one, is `Ignored` as `Malformed`, and nothing is placed or folded in. **`ModeChanged`** belongs to its Channel when the target is a Channel's name, and to the Network for a user mode.
- **Another User's `Quit`** belongs to every Channel they shared with Self as the step began, counting a `NAMES` listing still being read, and to their Direct Messages, `existing`. **Another User's `NickChanged`** belongs to the same Channels, and, when it is live, moves their Direct Messages with `DirectRenamed`, as a Timeline follows its partner's nick ([ADR 0011](../../docs/adr/0011-timelines-are-a-projection-the-client-routes.md)). The Client does not know whether a Direct Message Timeline exists, so it names one, and the projection applies it only to one that does. One from history never renames anything, since the old nick may be someone else's by now: it belongs to the old nick's Direct Messages, `existing`, and the same Channels. A User whose nick, old or new, is not a nick by the rule above has no Direct Messages to touch, and what touches nothing else belongs to the Network.
- **Self's `NickChanged` or `Quit`** belongs to the Network and every Channel Self is in.
- **Another User's `AwayChanged`** belongs to their Direct Messages, `existing`. Self's belongs to the Network.
- **History** is placed by what is known as it arrives, as the present is, since a Line from history never changes what is known. It moves no Timeline either, so only a live `NickChanged` carries `DirectRenamed`.

The casemapping the keys fold with is the Network's, not the Connection's. It is the one an Ircd last declared, by a `005` that names `CASEMAPPING` or `UTF8MAPPING`, set or taken back, on any Connection, and `rfc1459` until one has. A `005` that names neither leaves it as it is, and so does a new Connection, so a Timeline keeps its key across Connections while the Network keeps its mapping. Knowledge folds by the Connection's mapping, which starts from `rfc1459` on each Connection, so on a Network that declared another, its keys and those in `where` differ from a Connection's start until its Ircd declares the mapping again. A mapping the Client does not know folds as `ascii`, as in Knowledge.

When an Ircd declares a mapping other than the Network's, it becomes the Network's, and a `Refolded` reports it at that step, before any News keyed by it. `Refolded` carries the mapping keys now fold with, so a mapping the Client does not know is reported as `ascii`, and a change from one unknown mapping to another, which changes no key, reports nothing. A projection then folds the name of each Timeline it holds again, with `casefold` from `@iirc/protocol/casemapping` under the new mapping, and of Timelines whose keys now meet, keeps the one it saw first, as Knowledge keeps the first of Channels a new mapping merges. Its later News is keyed the same way, so a Message or a `DirectRenamed` finds the Timeline again.

A `ReadMarker` carries one `where`, worked out from its Target as a `Say`'s is: a Channel's, after any `STATUSMSG` prefixes, or a Direct Message partner's, always `existing`, since marking read starts no Timeline. With no Target, it is the Network's own.

`Confirmed` and `Refused` carry no `where`: each names the intent of a Message already placed. A `Refused` for an `Act` names no Message, so it carries `action` instead: `attempted`, what the action tried in short, and `where`, the one Timeline its refusal belongs to, so a projection can show it there, since a Frontend never reads News.

- **What was tried** is the action's kind and the names the Owner gave it, and nothing else: `Topic { channel }`, `Kick { channel, nicks }`, `Mode { target, modes }`, with `modes` each change's sign and letter, as `+ko-v`, `Invite { nick, channel }`, `Nick { nick }`, `Away { away }`, and `Raw { command }`, the raw Line's command, or `null` when it did not parse. No topic, reason, away message, mode parameter, or rest of a raw Line is in it, so a Channel key given with `+k`, or anything else typed there, never is.
- **Where it belongs** is the Channel a `Topic`, `Kick`, `Invite`, or Channel `Mode` was about, when the Client held that Channel, wanted or joined, as the action was asked for, keyed as `where` keys it. Otherwise it is the Network's own, and so is a `Nick`, `Away`, `Raw`, or Self's own `Mode`. An `Invite` goes to its Channel, not to the nick's Direct Messages: the Channel is what it acts on, and what a refusal such as `482` or `443` is about. A Channel the Client does not hold has no Timeline worth starting for a refusal.
- **Immediate and later alike.** A refusal in the step that took the action, `Offline` or `Unsendable`, carries it, and so does one that comes later, `Rejected` or `Unsent`, from the action the Client remembers by intent, at most 64, the oldest forgotten first, outliving Connections, since an `Unsent` can come after its Connection ended. A refusal of an action forgotten carries none, as a `Say`'s does. A Channel's key is folded as the refusal is reported, from the name as said, by the casemapping the Network last declared then, so after a `Refolded` it names the Channel's Timeline as the projection has re-keyed it, and never opens a second one. `Refolded` carries none either, since it re-keys every Timeline. Session and Connection News belong to the Network.

## Knowledge

`known(state)` gives Channels, members, Users, Self, and where the Session is. Channels and Users are keyed by name folded with the casemapping in force, named as `@iirc/protocol/casemapping` names it: `ascii`, `rfc1459`, `rfc1459-strict`, or `rfc8265`. Until the Ircd says, it is `rfc1459`, and a mapping the Client does not know folds as `ascii`. Each Connection starts from `rfc1459`, whatever the last Ircd said. When the casemapping changes, every key is folded again, and the Channels are reconciled with the Configuration: a wanted Channel the new mapping tells apart from another gets its own machine, and of Channels it merges, the first is kept. The keys in News's `where` fold by the mapping the Network last declared, which can differ from a Connection's until its Ircd declares one ([Where News belongs](#where-news-belongs)). Users are those who share a Channel with Self, and Self: what was seen of a User is forgotten once they share none. Self's away status is as the Ircd confirmed it, never as the Owner asked: not away as a Session begins, from `receipt`, then from a `306`, with the message of the last `AWAY` sent on the Connection, a `305`, or Self's own `AWAY`, as `away-notify` may send it, each from `ircd`. Knowledge also says `declared`, the casemapping an Ircd last declared on any Connection, which folds the keys of `where`, or `undefined` until one has, while keys fold by `rfc1459`, and `chantypes`, the Session's `CHANTYPES`, or `undefined` with no Session, so a Frontend compares and prefixes Channels' names as the Network does. A Channel's `wanted` says whether the Owner wants Self in it, which is false for one Self was put in without asking. Every fact is a `Fact<T>`:

| Case      | Means                                                        |
| --------- | ------------------------------------------------------------ |
| `Known`   | True as of `at`, from a source                               |
| `Partial` | A set with at least these members. Only sets can be partial. |
| `Stale`   | Was true, and is no longer kept up to date                   |
| `Unknown` | Nothing has told us                                          |

A fact's source is `ircd` (said as it happened), `replied` (said in reply to a Lookup), `receipt` (inferred from when a Line arrived), or `ours` (we said or set it). Nothing in Knowledge names a cap or a Feature. A View learns how a fact is known, never why, so a new Feature changes which case a fact lands in and not the View's code. `@iirc/client/known` imports nothing from the rest of the Client, and the lint fence holds it to that.

### One Channel

`channel(state, name)` gives what Knowledge knows of one Channel, for a View that shows that Channel alone, such as its member list: `{ key, casemapping, ranks, chanmodes, chantypes, channel, users }`. It folds `name` with the Connection's casemapping and finds the Channel Knowledge keys by it, so any spelling that mapping folds alike finds it, and gives `undefined` when the Client holds no such Channel, as for one Self parted and the Owner no longer wants. `channel` is exactly the `ChannelKnowledge` that `known` gives for that key, `users` is each of its members as `known` gives them as Users, Self included, under the members' keys, so a member's `away` is there, `ranks` is `PREFIX`, most privileged first, as each `{ mode, symbol }`, or the protocol's default `(ov)@+` until an Ircd says, `chanmodes` is `CHANMODES` as `{ list, always, whenSet, flags }`, how each other mode takes a parameter, or RFC 1459 and 2812's `beI,k,l,imnpst` until an Ircd says, and `chantypes` is `CHANTYPES`, or `#&` until it says, so a Frontend parses a mode change, or tells a Channel's name from a nick, exactly as the Client will check it. It reads that Channel and its members and nothing else of the Network, so it costs what the Channel holds: `known` builds every Channel and User, about 4 ms for three Channels of 10,000 members each, where `channel` builds one. `src/views.test.ts` checks it against `known`, across spellings, and for a Channel Self is still joining.

A Timeline is keyed by the casemapping the Network last declared, and `channel` by the Connection's, so a View that finds a Channel from its Timeline passes the Timeline's name, not its key. The two mappings differ only from the start of a Connection to a Network that declared a mapping other than `rfc1459` until its Ircd's `005` says that mapping again. Self joins no Channel before `001`, and Ircds send `005` with registration, so a Channel is rarely joined in that window. A name looked up then folds by `rfc1459`, as every key of Knowledge then does, so where the two mappings fold a name differently, it can find a Channel whose name only `rfc1459` folds alike to it, or none, until the `005` comes.

## Inspection

`inspect(state)` gives what Views do not need: each machine's state, the Connection, the caps offered and enabled, ISUPPORT, the STS policies by host, the Features on, and the timer table. `states` names each machine's state as the statecharts do:

| Machine | States |
| --- | --- |
| `network` | `Unconfigured`, `Idle`, `Waiting`, `Connection.Dialing`, `Connection.Open`, `Connection.Closing` |
| `caps` | `Listing`, `Requesting`, `Holding`, `Ready.Steady`, `Ready.Changing`, `None` |
| `presence` | `Registering`, `Session` |
| `keepalive` | `Listening`, `Pinged` |
| `channel <name>` | `Wanted`, `Joining`, `Joined.Syncing`, `Joined.Synced`, `Refused`, `Kicked` |

A machine that is not running, such as `caps` with no Connection open, is left out.

## Invariants

- **Pure.** `step` reads no clock, randomness, locale, or time zone, and does no I/O. So it uses no `DateTime`, whose zoned constructors default to the machine's time zone, nothing locale-aware such as `localeCompare`, and no Schema that parses a date in local time, such as `Schema.DateFromString`. The lint fence catches the obvious cases, such as `Date`, `Math.random`, Effect's `Clock` and `Effect`, and Bun or Node. Review catches the rest.
- **Plain data.** State holds only strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. It never holds a function, a class instance, or a `HashMap` or `HashSet`, because Effect hashes a value by reference with `Math.random`, so their order could differ on replay. Lint cannot see this. The transcript test kit checks it after every scenario, and `replayFresh` folds again in a fresh process, so that a hash seeded in one run cannot match the next.
- **Total.** `step` never throws, for any input in any state.
- **Hardened, not tuned.** The Client accepts anything the protocol allows, from any Ircd: a reply at any point it may legally come, tags and names in any order, and optional parts present or absent, such as a trailing colon or a `time` tag. The Ircds we record, such as Ergo and ngircd, show where Ircds differ. They are examples, never the cases to code for, so an Ircd we have never seen still works. What it cannot read is `Ignored`, never fatal.
- **Exact replay.** Folding the Journal's inputs from `initial` gives the same states, outputs, and News. The Client never reads its outputs back.
- **Time comes from inputs.** Every `Wake` instant is computed from the `at` of an input: the one being stepped, or, for the keepalive, the one that last brought a Line, which is never later. A `Fired` carries the `due` instant its `Wake` set, so a firing from an earlier setting of a timer that was reset or cancelled since is stale and ignored. Timers are one-shot: once the Client has stepped a `Fired` whose `due` matches, the timer is gone, and the Client sets it again with a fresh `Wake` if it still wants it. The Runtime gives `due` back unchanged. `Fired` names only the timer, so State keeps which machine each timer belongs to and what it means. Each machine's timers are derived from its state, and a step outputs a `Wake` for each difference, so leaving a state cancels its timers ([ADR 0009](../../docs/adr/0009-client-machines-are-reducers.md)).
- **One Connection at a time.** The Client dials only when no Connection is open: after the previous Connection's `Closed`, or after `Started`, which ends any it believed open. A `Configured` or `Started` with the Network enabled dials at once, unless a redial is pending: only a redial after a `Closed` waits for backoff, a `Configured` leaves that wait as it is, and `Started` or `Retry` cuts it short. A `Configured` that disables the Network while connected hangs up, and so does a `Stopping`, after which nothing is dialled until the next `Started`. Once the Client has begun to hang up, it sends nothing more on that Connection.
- **Credentials appear only by name.** No input or output holds a Credential's value.
- **Never insecure under STS.** Once an Ircd has given a policy over TLS, the Client dials that host only over TLS, on the policy's port, until the policy expires, and never falls back to plaintext. [Strict Transport Security](#strict-transport-security) has the details.
  - A policy is learnt only over TLS, from `duration`, on the port of the Connection it arrived on. A `port` key sent over TLS is ignored.
  - `duration=0` removes the policy at once. When a Connection that opened over TLS ends, the expiry moves to its end plus the last `duration`.
  - It survives restarts because it is derived from journaled Lines, and is never ended by `CAP DEL`. Its expiry is checked against inputs' `at`, never a clock.
  - Over plaintext, only `port` counts: it ends the Connection with `Upgrading` and dials TLS on that port at once. A `duration` sent over plaintext is ignored.
- **A required login is never skipped.** A Session begins, and anything is sent past registration, only if the Configuration in force does not require a login, or a `903` arrived, live, on this Connection. The core holds to this itself, whatever the Features do: before `CAP END`, at `001`, and whenever a `Configured` arrives. A `Configured` that requires a login on a Session that never logged in gives the Connection up with `LoginFailed`. One that requires it before `CAP END` lets SASL begin if it can, and otherwise gives up; after `CAP END`, or with an Ircd that has no cap negotiation, it gives up at once. A Connection given up at `001` takes up no Session.
- **History does not change the present.** A Line a Feature marks as not `live`, such as one from a `chathistory` batch, is reported as News with `live` false, and never changes what is known now: membership, nicks, topics, modes, away status, and every machine stay as they were. It says what was, not what is.
- **Decisions come from structure.** Commands, numerics, tags, and parameters decide behaviour. An Ircd's free text never does, and it may appear in News only as data.
- **A step costs what its Line touches.** A step does work in proportion to its Line and the parts of State it changes, never to every member of the Network: a Message costs the same in a Channel of ten members as in three of 10,000, a `JOIN`, `PART`, or `QUIT` copies the members of the Channels it changes, and the Users seen when it changes one, and a `NAMES` listing costs about what it lists. So a busy Network, and every replay of its Journal, does not slow as it grows. `scale.test.ts` holds it to that on 30,000 members with every Feature on, by its own bounds on what each step costs, with a test timeout of 60 s so a loaded machine building the Channels does not fail it, and `bun run bench:scale` prints what each step costs.
- **Bounded.** Everything the Client holds from Ircd input has a bound, and so does what it keeps of the Owner's actions to tie answers to: at most 64 Lines a Connection, and to place their refusals: at most 64 actions. A hostile Ircd can make facts unknown, but it cannot make the state grow without limit. Read Markers are added only by the Owner's `Read`: an Ircd's renames and casemappings move and merge them, and never add one.

## What the caller must do

- Journal each input before stepping it. Step inputs one at a time, in Journal order.
- Journal each step's outputs with its input, then carry them out in order.
- On restart, fold the Journal from `initial`, keeping only the timer table, folded with `timers` from each step's input and outputs, then set those timers and step a `Started`.
- Send `Configured` first. Until then, every other input is ignored.

## Error modes

| Input | What happens |
| --- | --- |
| Bytes that do not parse | `Ignored` with `Unparseable`. The bytes stay in the Journal, and the Connection stays up. |
| A Line whose parameters do not fit its command, such as a `TOPIC` whose Channel is not a Channel's name | `Ignored` with `Malformed`. |
| A tag value that does not parse, such as `time=yesterday` | The fact keeps its default, such as the time of receipt. |
| An `sts` value whose `duration` or `port` is malformed, such as `duration=abc` | That part is taken as not given. A value missing its required part changes nothing, and a policy already held stays. |
| Input from an old Connection | `Ignored` with `StaleConnection`. |
| `Fired` for a timer that was reset or cancelled | `Ignored` with `StaleTimer`. |
| An input that makes no sense now, such as `Opened` twice | `Ignored` with `NotNow`. A Line that makes no sense now, such as a `CAP ACK` when nothing was asked or a second `001`, is `NotNow` with `Received`. A Line the Client does not read, such as most numerics, is not ignored: it changes nothing, and that is no error. |
| An Owner intent that cannot be carried out, such as `Say` while offline | `Refused` with the intent id. It is not queued. |
| A `Read` whose Target names no one Timeline, such as a mask, `nick@server`, or anything holding a `,`, which makes it a list even with empty items, as `#a,` | `Ignored` with `NoTimeline`. A `Read` no later than the Read Marker it would move changes nothing and reports nothing. |
| A Line a Feature refuses at egress | A `Say` is `Refused` with `Unsendable`. Any other Line is `Ignored` with `Unsendable` and its command, such as a `PONG` that is not UTF-8 under `UTF8ONLY`. Nothing is sent. |
| `Unsent` | A `Say` whose Line is among them is `Refused` with `Unsent`, once, unless the Ircd confirmed it on that Connection, of which the last 64 are remembered. This holds whether or not the Connection is still current. Any other Line changes nothing, and no `Ignored` is reported: its Connection is ending. |
| `Unfilled` | SASL sends `AUTHENTICATE *` and counts as a failed login, so a required login abandons the Connection. A Channel whose key is unfilled is `Refused` until the next Session or the next `Configured`. Registration goes on without `PASS`, and the Ircd decides. With no Feature holding registration to hear it, such as on the floor, an unfilled `AuthenticatePlain` is `NotNow`. |
| A Feature hook that throws | That Feature is off for the rest of the Connection, and `Ignored` with `FeatureFailed` records it. |

## The Feature seam

A Feature brings one IRCv3 cap or ISUPPORT token, or a tight group of them, to the Client. The seam is internal: it is not exported, and Features are tested only through `step`. The types are in `src/feature.ts`.

- **On and off.** A Feature is on while every cap in `needs` is enabled and every token is in ISUPPORT, unless the Owner declined it. The core works this out again on `CAP ACK`, `CAP NEW`, `CAP DEL`, ISUPPORT, and at the end of a Session.
- **Asking.** A Feature's caps are those it `needs`, then those it `uses`: caps it reads but can be on without, as `echo-message` uses `labeled-response`. They are asked for together, and only when every one is offered, so a Feature never asks for part of what it wants.
- **State.** A Feature's `own` state begins as it first turns on in a Connection, and is kept while it is off, so turned on again in the same Connection it goes on from where it was. Each Connection begins it again.
- **Order.** Ingress runs `tags`, then `batch`, then `label`, then `react`, then `meaning`. Egress runs `egress`. Within a stage, Features run in the order of one registry array in one file.
- **Refining, then acting.** `tags`, `batch`, `label`, and `meaning` only refine: the core keeps what they return and their own state, and discards any Lines they ask to send, say over registration, or caps to drop. Only `react` acts on what arrived, and the core calls it only for a live Arrival, after `label` has told history apart. So nothing from history sends a Line or decides registration, whatever a Feature does. A Feature must still not let history change own state that later decides what it sends: SASL keeps all of its exchange in `react`.
- **Refining, not branching.** A hook takes what the core derived and returns it refined, in the core's own vocabulary. The model reads the result and never asks which Feature produced it.
- **Placing.** `meaning` sees Messages and Activity without `where`. The core works out [where each belongs](#where-news-belongs) as it folds it in, so no Feature places News.
- **Effects.** A hook returns `{ value }`, with optional effects: its new `own` state, Lines to `send`, caps to `drop`, and a say over `registration`: `Hold` it open before `CAP END`, as SASL does, then `Continue`, or `Abandon` it with a reason, which ends the Connection. A cap to `drop` that is still enabled is given up with `CAP REQ :-cap`, and its answer is awaited as for any request, so negotiation is not over, and `CAP END` waits, until it comes.
- **Reading.** Every hook reads `at`, the Configuration, the values of its own caps, whether they are enabled, ISUPPORT tokens, and `known`: what the Client knew before this step of where the Session is, how names fold, and Self. That part of Knowledge is read from State in constant time, so the Features cost a step the same however many Channels and members the Network has. A Feature that needs more of Knowledge widens it with a narrow reading of its own, never the whole of `known(state)`.
- **Configuration.** `configured` runs for each Feature that is on when a `Configured` arrives while negotiation is still open before `CAP END`, so SASL can begin a login the Configuration now names.
- **Starting and absence.** `start` runs as a Feature turns on, and again while it is on when a cap it `uses` is enabled or disabled. `absent` runs for each Feature that is off when it could matter: as negotiation settles, before `CAP END` and after a later answer, when an Ircd answers `CAP` with `421`, at `001`, and as the Feature turns off. SASL gives up the Connection there when a login is required and none was made.
- **Unfilled.** A Feature holding registration hears, through `unfilled`, of a `SecretLine` the Runtime could not fill, so SASL can abort and decide as for a failed login.
- **Echo.** A `Departure` starts with `echo` false. An `egress` hook that can tie the Ircd's echo to the intent sets it, as `labeled-response` with `echo-message` does, and the Message reports it as `ours.echo`. The core never sets it. A `Departure` is `Said` for a `Say`, `Acted` for a Line of an `Act`, or `Protocol`. For an `Acted` one, `echo` says the Ircd's answer is tied to its intent by label, so the core does not also tie it by the answer's parameters.
- **Refusing.** An `egress` hook may refuse a Line instead of refining it, and later Features do not see it. The core does not send it: a `Say` is `Refused` as `Unsendable`, with no Message, and any other Line is `Ignored` as `Unsendable`, with its command.
- **Turning off.** When a Feature turns off, the core marks stale the facts it `keeps` that no Feature still on keeps: a User's away status, account, mask, or realname, or members' prefixes a Feature made complete. It rewrites them as stale in State at that moment, rather than working out later from instants which facts came after, so whatever is said of a fact afterwards is fresh, even at the same instant. A Feature holding registration decides with `expired` whether to go on, then hears `absent`. No Feature handles `CAP DEL` itself, and nothing is polled.
- **Deadlines.** Features set no timers. While any Feature holds registration, the core keeps one deadline, and when it passes it calls each holding Feature's `expired` hook to choose `Continue` or `Abandon`. `001` ends a hold too, and so does the Feature turning off, with the same call. SASL uses this to go on without login when login is optional, and to give up when it is required. A Feature that gives up the Connection at `001` keeps the Client from taking up the Session.
- **Encoding.** A Feature can say how bytes become text while it is on, as `UTF8ONLY` does.

- **Answers and history.** `label` can tie an Arrival to the intent it `answers`, and a later stage can mark it as not `live`. The core then confirms the intent with an echo from Self, or rejects it with an error numeric, a `FAIL` by its code, or an `ACK`, or treats the Line as history.

STS is not a Feature. Its policy outlives Connections and decides where to dial before any cap is negotiated, so the core keeps it, in `src/sts.ts`. With no `sts` cap, nothing changes, so the floor does not depend on it.

Three Features, to show the shape, simplified from `src/features/`:

```ts
// The floor shows only a member's highest prefix, so the core reads a NAMES listing
// as partial. With multi-prefix, every prefix is shown, so the listing is complete.
export const multiPrefix: Feature = {
  name: FeatureName.make("multi-prefix"),
  needs: { caps: [CapName.make("multi-prefix")] },
  keeps: ["member.prefixes"],
  own: undefined,
  meaning: (meant) => ({
    value: meant.map((m) =>
      m._tag === "Listed"
        ? {
            ...m,
            members: m.members.map((member) => ({
              ...member,
              prefixes: complete(member.prefixes),
            })),
          }
        : m
    ),
  }),
};

// A Message's time comes from the Ircd, not from when it arrived. A malformed time
// leaves the time of receipt in place.
export const serverTime: Feature = {
  name: FeatureName.make("server-time"),
  needs: { caps: [CapName.make("server-time")] },
  own: undefined,
  tags: (arrival) => {
    const time = parseTime(arrival.line.tags.get("time"));
    return {
      value:
        time === undefined
          ? arrival
          : { ...arrival, time: { _tag: "Known", value: time, from: "ircd", at: time } },
    };
  },
};

// The core already reads AWAY Lines. What this Feature changes is that away status is
// kept up to date, so when the cap is deleted, every away fact goes stale.
export const awayNotify: Feature = {
  name: FeatureName.make("away-notify"),
  needs: { caps: [CapName.make("away-notify")] },
  keeps: ["user.away"],
  own: undefined,
};
```

## Features

Each feature is built from the floor up: what it needs, what it changes, and where its scenarios are. A feature exists when its scenarios pass. Every scenario plays strictly through `step`, in `src/scenarios/`.

### Connecting and redialling

- Needs: nothing. The floor.
- Changes: dials the first Ircd at once on `Configured` or `Started`. After a `Closed`, it waits on the one backoff, 2 s doubling to at most 5 minutes, then dials the next Ircd in `ircds`. A Session that lasted 5 minutes starts the backoff again from 2 s. The backoff takes no randomness: one Daemon serves one Owner, so there is no herd to spread out. `Retry` dials at once while waiting. Disabling hangs up, and enabling dials. Connection ids start at 1, and only one Connection is open at a time. `ERROR` from the Ircd is why its Session ended.
- Scenarios: `connection.test.ts`

### Registration and cap negotiation

- Needs: nothing. An Ircd with no cap negotiation answers `CAP` with `421`, or ignores it and sends `001`.
- Changes: sends `CAP LS 302`, `PASS` as a `SendSecret` when configured, `NICK`, and `USER` at once. Reads `CAP LS` over as many Lines as it takes, requests the caps of the Features in the registry less those declined, and sends `CAP END` when nothing is awaited and no Feature holds registration. On `432`, `433`, `436`, or `437` at any point before `001`, it offers the next nick: the configured nicks in order, as the Owner wrote them, then `_` added to the first, then `2`, `3`, and on, the first cut to leave room for the suffix within `NICKLEN`, or RFC 2812's 9 until the Ircd announces it. A fallback is made only if it keeps at least the first nick's leading character, and that character may start a nick. Once a suffix leaves no room, as with `NICKLEN=1` or after `i9` with `NICKLEN=2`, the Client offers no nick for that `433`, and the registration deadline ends the Connection unless a later `005` raises `NICKLEN`, after which the next `433` resumes the offers where they stopped. A nick that cannot be sent is skipped. Registration that takes more than 60 s ends the Connection. `CAP NEW` and `CAP DEL` change the caps for the rest of the Connection.
- Scenarios: `registration.test.ts`, on the floor

### The Session and ISUPPORT

- Needs: nothing.
- Changes: `001` begins a Session, and Self's nick is its first parameter, or with none, the nick `NICK` offered. Self's realname is the one `USER` sent. Both are what registration sent, whatever a `Configured` since says. Self's mask is never read from `001`, whose text is for people. It stays unknown until a structured source gives it, which on the floor is the echo of Self's own `JOIN`, and until then a `Say` keeps the conservative allowance for the source an Ircd adds when it relays. `900` and `901` give Self's account. ISUPPORT accumulates over every `005`, a negated token is taken back, and at most 256 tokens are kept. `CASEMAPPING`, `UTF8MAPPING`, `PREFIX`, `CHANTYPES`, `STATUSMSG`, `CHANMODES`, and `TARGMAX` are read with `@iirc/protocol/isupport` and `@iirc/protocol/casemapping`, with the protocol's defaults until they are sent. `SessionBegan` and `SessionEnded` report it.
- Scenarios: `session.test.ts`

### Keepalive

- Needs: nothing.
- Changes: answers the Ircd's `PING` at once, before or after `001`, echoing its first parameter byte for byte through `rawParams`, so a token that is not UTF-8 comes back exactly. One timer checks when a Line was last heard: after 60 s of silence it sends `PING iirc`, and after 90 s it hangs up, and the Session ends `Silent`. A Line heard changes only State, never a `Wake`.
- Scenarios: `keepalive.test.ts`

### Channels

- Needs: nothing. Without `multi-prefix`, a member's prefixes are partial.
- Changes: each Channel the Owner wants is a machine: Wanted, Joining, Joined (Syncing, then Synced at the end of `NAMES`), Refused, and Kicked. After `001`, and whenever the Configuration wants more, every Wanted Channel without a key shares `JOIN` Lines, as many to a Line as fit and as `TARGMAX` allows. One with a key goes alone as a `JoinWithKey`. Self is in a Channel on the echo of its `JOIN`. A `NAMES` listing over any number of `353`s replaces the members at its `366`, each `353` costing what it lists, and a `JOIN`, `PART`, `QUIT`, `KICK`, `NICK`, or membership `MODE` that arrives while it is pending changes it too, so nothing is lost when it ends. A member listed with a prefix holds at least that one, and one listed with none holds none, since the floor shows only the highest. A leading symbol `PREFIX` does not name is a prefix that cannot be named, so what is known is partial. The topic comes from `332`, `333`, and `331`, as said on joining or replied later, and a join whose replies end with no topic has none. Modes come from `324` and follow `MODE`, with list and membership modes left out and a key shown only as set. `403`, `405`, `437`, `471`, `473`, `474`, `475`, `476`, `477`, and `489` refuse a Channel Self is joining, and a kick, or a `PART` the Owner did not ask for, removes Self: each is joined again on the one backoff, which starts again once joined. A Channel no longer wanted is parted. A Session ending returns every wanted Channel to Wanted. A key that cannot be filled refuses its Channel until the next Session or `Configured`. At most 100,000 members are kept for a Channel.

  A Channel Self is put in without asking, such as by an oper's `SAJOIN` or another session of the same account, is not undone. Its `JOIN` makes a machine, Joined and not wanted, that syncs and is modelled like any other, and Knowledge shows it with `wanted` false. It is never joined again: it is forgotten when Self leaves it or the Session ends. A Configuration that names it makes it wanted, and one that does not leaves it alone. Such Channels are counted within their `CHANLIMIT` group, so `#:1,&:1` keeps one of each and `#&:2` keeps two between them. A prefix in no group, or a group with no limit, is counted the same way against 64, and past that one is reported as Activity and `Ignored` with `NotNow`, and modelled no further.

- Scenarios: `channels.test.ts`

### Messages and Activity

- Needs: nothing. Without `server-time`, a time is when the Line arrived, and says so. Without `labeled-response` and `echo-message`, our own Messages are reported when we send them, and stay unconfirmed.
- Changes: `PRIVMSG` and `NOTICE` are a `Message` with sender, Target, and kind, and a CTCP `ACTION` is an `Action`. Other CTCP is a request between IRC clients, not something said, and is neither reported nor answered. A Line with no source names the Ircd as its sender. Client-only tags are kept as data. `JOIN`, `PART`, `QUIT`, `NICK` (Self's included), `KICK`, `TOPIC`, `MODE`, and `AWAY` are Activity, and fold into what is known of Channels, members, and Users. Each Message and Activity names the Timelines it belongs to, by [the rules above](#where-news-belongs), and an Ircd that declares another casemapping is reported with `Refolded`. A `Say` is sent, and reported as a `Message` that is `ours`, at the time we said it. It is `Refused` with `Offline` outside a Session or while hanging up, and `Unsendable` when no Line can carry it, or when the Ircd would cut it short relaying it with our source.
- Scenarios: `messages.test.ts`, and `where.test.ts` for where each belongs, with a property test in `properties.test.ts` that every Message and Activity belongs somewhere, keyed by the mapping the Network last declared, which is the one Knowledge keys by whenever the Connection's mapping is the same.

### Acting

- Needs: nothing. With `labeled-response` and `echo-message`, the Ircd's answer is tied by label.
- Changes: an `Act` sends what the Owner asks, built only through `@iirc/protocol`'s builders, and checked against what the Client knows of the Network first, so a Line that cannot be sent whole, as the Ircd reads and relays it with our source, is `Refused` as `Unsendable`, and is never cut short. Lengths count UTF-8 bytes, which an Ircd counting characters never exceeds. Every action but `Away` needs a Session, and is `Refused` as `Offline` without one, or while hanging up or shutting down. An action of several Lines is sent whole or not at all, and each of its Lines carries its intent, so an `Unsent` refuses it as it refuses a `Say`.
  - **`Topic { channel, text }`** sends `TOPIC`, to a Channel's name by `CHANTYPES`, within `TOPICLEN`. An empty text clears the topic, sent as `TOPIC #chan :`.
  - **`Kick { channel, nicks, reason }`** sends `KICK` of one or more nicks, each a nick as [names](#where-news-belongs) reads one, so `@peer` with `PREFIX=(ov)@+` is not one. Nicks share a Line as `TARGMAX` allows for `KICK`, one to a Line when it says nothing of `KICK` or is not sent, as RFC 1459 has it, and as many as fit when it gives no limit. The reason, `null` for none, is within `KICKLEN`.
  - **`Mode { target, changes }`** changes a Channel's modes, or Self's. Each change is `{ set, mode, param }`, with `param` `null` for none. On a Channel, a mode takes a parameter exactly as `PREFIX` and `CHANMODES` say: a membership mode, a list mode, and a type B mode both ways, a type C mode only when set, and a type D mode never, and a mode neither names is `Unsendable`, since no rule says how it reads. The changes are split across Lines by `MODES`, which counts only the changes with a parameter, 3 when it is not sent and none when it gives no limit, and by what fits, in the order given, each run of one sign written once, as `+oov-l a b c`. A User's modes are only Self's, and a parameter goes as given. A parameter is one word.
  - **`Invite { nick, channel }`** sends `INVITE`.
  - **`Nick { nick }`** sends `NICK`, within `NICKLEN`, or RFC 2812's 9 until the Ircd says. Self's nick changes when the Ircd's `NICK` from Self says so, as any rename does. It lasts the Session: each Session registers with the Configuration's `nicks`, which stay the preferred list, so a nick to keep belongs in the Configuration.
  - **`Away { message }`** describes the Owner, so it is kept at the Network's level, outliving Sessions and Connections, whether or not a Session is up. In a Session it sends `AWAY` at once, within `AWAYLEN`, and `null` or `""` sends `AWAY` with no message, to come back. Each Session begins by sending the Owner's away message again, right after `001`, before joining. `AWAYLEN` is not known then, since the Ircd sends its `005`s after `001`, so the message goes as the Owner set it, and one no Line can carry is `Ignored` as `Unsendable` with `AWAY`. Knowledge reports Self away only as the Ircd confirms it.
  - **`Raw { line }`** sends a Line written as text, as `/quote` does, read and built by `quote` from `@iirc/protocol`, so it goes as it reads, and what does not parse, has a source, or cannot be sent is `Unsendable`. It may carry client-only tags, but not `label` or `batch`, which the Client ties answers by. It may not be `CAP`, since negotiation is the Client's own and an `ACK` it did not ask for is ignored, nor `PASS`, `AUTHENTICATE`, or `OPER`, which carry a Credential, in any case, since a Line written as text is journaled as written. Raw is for what the model does not cover, so a `JOIN` or `PART` naming any Channel the Configuration wants is refused whole, even when its other Channels are not wanted, and so is `JOIN 0` while any is wanted: joining and parting are changes to the Configuration, which a Frontend makes with `/join` and `/part`, and a raw `PART` of a wanted Channel would be joined again as a kick is. A raw `JOIN` of a Channel the Configuration does not want is sent, and followed as a Channel Self was put in without asking. It is never filled from the Vault. The Client does not model what it does beyond what the Ircd's replies show, and an `AWAY` sent this way is the one a `306` confirms. So a raw Line desynchronises nothing the Client relies on: the Client decides from what the Ircd sends back, so a `NICK`, a `JOIN` or `PART` of a Channel not wanted, or a `MODE` sent raw is followed as the Ircd echoes it, as if another IRC client of the same account had sent it.
- **What the Ircd says of it.** An action is `Acted` once its Lines are sent. What the Ircd does is read as any Line is, as Activity and Knowledge. Its refusal is tied to the action only by structure, and reported as `Refused` with `Rejected` and the numeric:
  - With `labeled-response` and `echo-message`, each Line is labelled, and its answer's first error numeric or `FAIL` rejects it, as [Echoes](#echoes) says.
  - Otherwise, on the floor, an error numeric is tied to the oldest Line of an action on the Connection that names what the numeric names: `482`, `442`, `403`, and `476` by the Channel, to a `TOPIC`, `KICK`, `MODE`, or `INVITE`; `467` by the Channel, to a `MODE`; `401` by the nick, to a `KICK`, `MODE`, or `INVITE`; `441` by the nick and the Channel, to a `KICK` or `MODE`; `443` by the nick and the Channel, to an `INVITE`; `432`, `433`, `436`, and `437` by the nick, to a `NICK`; and `421` and `461` by the command they name, to any action, a raw Line included. An action is refused once, however many of its Lines a numeric names. A Line's targets, the nicks of a `KICK` and the changes of a `MODE`, are each answered on their own, one occurrence at a time, so a nick or a parameter given twice is awaited twice: by Self's `KICK` of that nick, by a change Self's `MODE` makes with the same sign and letter, or by a numeric that names it, such as `441`. So with `KICK #iirc a,b`, Self's `KICK` of `a` leaves `b` awaited, and a later `441` for `b` refuses the action. A change is matched by its sign and letter alone, since an Ircd may rewrite its parameter, as a ban mask, or never show it, as a key, which Knowledge never keeps either, but a membership mode of a Channel, such as `+o`, whose nick comes back as sent, must name the same nick. A numeric that names only what the Line is about, such as `482` its Channel, answers the whole Line. A Line with no target is answered by a `TOPIC` or `NICK` from Self, or a `341`. Names are kept as said, and compared folded by the Connection's casemapping when the answer comes, so a casemapping an Ircd declares while a Line awaits still matches it. A Line answered in full is tied to nothing after, and at most 64 Lines a Connection await an answer, the oldest forgotten first.
  - What cannot be tied on the floor: a numeric that names nothing the action named, such as `472`, which names an unknown mode by its letter, and `501` and `502`, of Self's modes, which name only Self; an error for a Line sent elsewhere, such as by another IRC client of the same account, that names the same Channel or nick as a Line still awaiting an answer, which is tied to it, since nothing in the numeric tells them apart; and anything an Ircd says only in text. `AWAY` has no error to tie.
- Scenarios: `acts.test.ts`, for each action: the Lines sent, `MODES` splitting and the `CHANMODES` and `PREFIX` parameter rules, `TARGMAX` for `KICK`, refusals offline and past `TOPICLEN`, `KICKLEN`, `NICKLEN`, and `AWAYLEN`, malformed names and texts, `482`, `441`, `443`, `433`, `421`, and `461` tied and an error after success not, a `KICK` and a `MODE` whose first target succeeded and whose second is refused, a key and a ban settled by an echo that rewrites or hides the parameter so a later `482` refuses the `TOPIC` after it, a repeated nick, in two spellings that fold alike, and a repeated parameter each answered once, names compared by the casemapping declared after the Line was sent, from `ascii` to `rfc1459` and back, labelled answers, refused once for an action whose labelled Lines are each refused, `Unsent`, away sent again after `001` on every Session and kept while offline, a nick for one Session, a raw Line parsed, refused, including `OPER` and `PASS` in any case and a `JOIN` or `PART` of a wanted Channel among others, and followed, and where each refusal belongs: a Channel held, keyed by the declared mapping, the Network's own for a Channel not held, a nick, Self's modes, and a raw Line, modes named by sign and letter with no key, an `Unsent` after its Connection ended, and the oldest of 65 actions forgotten. `properties.test.ts` folds random actions, well-formed and not, from every state.

### Read Markers

- Needs: nothing. `draft/read-marker` would add the Ircd's own markers, and send ours with `MARKREAD`, through the same state.
- Changes: a `Read` moves the Read Marker of one Timeline to its `read` instant, when that is later than the one held, and reports `ReadMarker` with where it belongs. An earlier or equal instant changes nothing and reports nothing, so two Frontends marking at once cannot move it back ([ADR 0014](../../docs/adr/0014-read-markers-and-highlights-belong-to-the-client.md)). The Owner names the Timeline as a `Say` names a Target, read by the same parser in `src/names.ts`, or the Network's own with `target` null. A Target holding a `,` is a list, and names no one Timeline, before any item is read, so `#a,`, `,#a`, and `#a,,` mark nothing, though `#a` is the only item in each. Markers are keyed as `where` keys Timelines: Channels and Direct Message partners apart, each by its name folded with the casemapping the Network last declared, and the Network's own alone. A live rename of a Direct Message partner, the one that carries `DirectRenamed`, moves their marker to the new nick, as the Timeline moves. The new nick's marker becomes exactly the old nick's, earlier or later than one it had, or none when the old nick had none, as a projection detaches the Timeline already at that key: nothing says it is the same person, so a renamed Timeline never takes a stranger's marker, and a later `Read` for the partner is never ignored as behind one. A rename from history moves nothing. A `Refolded` folds each marker's name again by the new mapping, and where two keys meet, keeps the name of the one marked first and the later instant, as a merged Timeline has been read as far as either. Each keeps the name it was first marked by, or its partner's new nick, as a projection keeps the name a Timeline opened with. A `Read` needs no Session, and markers outlive Connections and restarts, rebuilt by replaying the Journal.

  After a casemapping change, a marker can sit under a different spelling's key than the projection's Timeline: the Client folds the name a marker was first marked by, and the projection the name its Timeline opened with, and where two spellings meet under the new mapping, each keeps its own first. The Client keeps its rule rather than share a representative name with the projection, since what it costs is small and nothing moves back. A marker can be left at a key no Timeline uses, which is stale and harmless, and a `Read` can go unreported because an equivalent spelling's later marker sits at the key, so a Timeline shows less read than the Owner marked until the next later `Read`. The projection keeps its own Read Marker for each Timeline from these reports, and moves it only forward, so no Timeline's marker ever moves back.

- Scenarios: `read.test.ts`, and `properties.test.ts`, which checks that only a `Read` reports a Read Marker, at its instant, keyed as `where` keys.

### Highlights

- Needs: nothing.
- Changes: a Message is a `highlight` when it is said live, by a User, and not by Self: not ours, not Self's echo, and not Self from elsewhere, by the source, and not the Ircd or another server. Its text, with formatting codes stripped by `@iirc/protocol/format`, must hold Self's nick in the Session, or one of the Configuration's `highlights`, as a whole word, compared by the Connection's casemapping, as Self's nick is. A whole word is bounded on each side by the start or end of the text, or by a character that cannot stand inside a nick by RFC 2812's grammar: anything but a letter, a mark, or a digit of any script, `-`, `[`, `]`, `\`, `` ` ``, `_`, `^`, `{`, `|`, or `}`. Letters, marks, and digits are those of **Unicode 17.0**, pinned as ranges in `src/word-characters.ts`, which `scripts/word-characters.ts` generates from a runtime of that version (`bun run generate:word-characters`), so the runtime's own Unicode tables never decide, and a Journal gives the same Highlights on every runtime, as `@iirc/protocol`'s casemapping touches no Unicode table at all. So an emoji, a zero-width joiner, and a mark of direction end a word, and a combining mark, an astral letter, a Hebrew or Arabic letter, and a digit of any script do not. Each word is found by Knuth–Morris–Pratt over the folded text, and each match's bounds are judged on the text as said, so the work for a Message is linear in its length for each word, however hostile the text or the nick. The Configuration allows at most 64 highlight words, of at most 64 characters each. So `iirc:`, `<iirc>`, `@iirc`, `iirc's`, and `example.test/iirc` name `iirc`, and `iirco`, `iirc_`, and `[iirc]` do not. Nothing is read as a URL. An empty highlight word names nothing. A Notice and an Action count as a Privmsg does. A Message from history is never one, since it does not call for the Owner now. A Direct Message is a Highlight only by these rules too: a projection ranks Direct Messages as their own level.
- Scenarios: `highlight.test.ts`, with boundaries in many scripts and a hostile nick that would take quadratic time, `word-characters.test.ts`, which checks that regenerating the table on a runtime of Unicode 17.0 gives the one committed, and skips that on a runtime of another version, since the table is what decides, and `properties.test.ts`, which checks that no Message from history, of ours, or from Self is one.

### What is ignored

- Needs: nothing.
- Changes: bytes that do not parse are `Unparseable`. A Line the Client reads whose parameters do not fit its command is `Malformed`. A Line that makes no sense in this state is `NotNow`. None of these ends the Connection, and nothing is decided from an Ircd's text.
- Scenarios: `ignored.test.ts`, and `properties.test.ts`, which folds random and hostile input from every state and checks the Invariants after every step.

### The Feature seam

- Needs: nothing. With no Feature on, the Client is the floor.
- Changes: the stages run on every Line as the seam above describes, and do nothing while no Feature is on. The registry in `src/registry.ts` lists the Features below, in the order their hooks run and their caps are asked for: `cap-notify`, `sasl`, `message-tags`, `server-time`, `batch`, `echo-message`, `multi-prefix`, `away-notify`, and `utf8only`. The core reads `PRIVMSG`, `NOTICE`, `JOIN`, `PART`, `KICK`, `QUIT`, `NICK`, `MODE`, `TOPIC`, `AWAY`, and `353` as `Meant`, through `meaning`. Every Line sent, the Owner's and the protocol's, goes through `egress`. Lines a hook asks to `send` do not go through `egress` again.
- Scenarios: `seam.test.ts`, which drives each stage through `step` with Features of its own, and `laws.test.ts`, which runs the four laws over every Feature in the registry, across every set of caps `across` gives.

### Cap negotiation

- Needs: caps from the Ircd. `CAP LS 302` turns on `cap-notify` implicitly, and the `cap-notify` Feature asks for it as well, for an Ircd that keeps to the older rules.
- Changes: asks, in registry order, for every cap each Feature needs or uses, when all of them are offered, less the Features the Owner declined and any Feature that would ask for a cap a declined Feature needs, which is worked out over the whole registry on every path that asks, `CAP LS` and `CAP NEW` alike, before narrowing to the Features a `CAP NEW` concerns, whatever order the Ircd lists them in. Values are read, such as `sasl=PLAIN,EXTERNAL`, and a value may hold `=`. Only what the Ircd acknowledges is enabled, and a `NAK` enables nothing of its request, even when it names only part of it. Only what was asked counts: an `ACK` for a cap not asked for, or one said again, is ignored. An `ACK` spread over several Lines, all but the last marked with `*`, enables nothing until its last, and counts as one answer. What it holds meanwhile is bounded by what was asked, and one spread over more than 16 Lines is taken as a refusal, and `Ignored` as `Endless`, during registration or in a Session alike. `CAP NEW` is answered at once, at any point: before `001`, while SASL holds registration, or after, for the caps of each Feature that needs a cap it names, so a Feature whose other cap was already offered is asked for whole, and nothing it lists that no Feature wants is asked for. `CAP DEL` turns off each Feature that needed a deleted cap, and the facts only it kept go stale. A Feature may give caps up with `CAP REQ :-cap`, as the echo Feature does with one of its two left alone, and negotiation waits for the answer.
- Scenarios: `caps.test.ts`

### Strict Transport Security

- Needs: the `sts` cap's value, which the core reads from every `CAP LS` Line, continuations included, and every `CAP NEW`, whatever negotiation is doing, before anything else decides whether the Line makes sense now. A `CAP NEW` that arrives while `CAP LS` is still listing is `Ignored` as `NotNow` for negotiation, but its `sts` value still counts. The core never asks for the cap, since the spec forbids requesting it. A policy is learnt only over TLS. With no `sts` cap, nothing changes. STS is core, not a Feature, but it is built from the floor up like one.
- Changes:
  - **Learning.** Over TLS, a valid `duration` stores a policy for the Connection's host: TLS on the port of this Connection, until the input's `at` plus `duration`. Each valid `duration`, from `CAP LS` or `CAP NEW`, resets the expiry, and `duration=0` removes the policy at once. A `port` key over TLS is ignored, and so is `preload`. A policy learnt mid-Session does not end it, and SASL and the Features go on as without it. `CAP DEL sts` changes nothing.
  - **Upgrading.** Over plaintext, a valid `port` ends the Connection with `Upgrading`, during registration or, from `CAP NEW`, in a Session: nothing more is sent, the Client hangs up, and once `Closed` arrives it dials the same host over TLS on that port at once, with no backoff and without moving on through `ircds`. A `duration` over plaintext is ignored, and nothing is stored. If the upgrade's TLS fails, that attempt is never retried in plaintext: it is a failed Connection like any other, and backs off. No policy was confirmed over TLS, and the spec binds the Client to TLS only once one is, so the next dial follows Configuration, and the Ircd may ask for the upgrade again.
  - **Dialling.** While a policy holds for a host, `at` before its expiry, every `Dial` to that host is TLS on the policy's port, whatever Configuration says: the first dial, a redial, `Retry`, `Configured`, and `Started` alike. Rotation through `ircds` goes on, each host under its own policy. A TLS failure backs off and retries TLS, never plaintext. Once the policy expires, Configuration applies again.
  - **Hosts.** Policies are keyed by host as a DNS name: folded to lower case in ASCII, with one trailing dot left off, so `Irc.Test.` and `irc.test` share one. An IP literal, a host with a `:` or only digits and dots, never gets a policy: the spec ties a policy to the hostname the Ircd sees through SNI, and TLS sends no name for an IP literal, which is also why HSTS leaves them out. An upgrade still applies to one, since it concerns only the Connection at hand.
  - **Rescheduling.** When a Connection that opened over TLS ends, whether closed, given up, or ended by `Started`, the expiry of its host's policy moves to then plus the `duration` last advertised, if the policy held when it was dialled or was learnt on it. A policy that expires while such a Connection is open is kept until it ends. A Connection that never opened moves nothing, so a run of TLS failures does not keep a policy alive.
  - **Values.** An `sts` value is comma-separated tokens, each `key` or `key=value`, in any order. Unknown keys and empty tokens are ignored. A `duration` or `port` that is not all ASCII digits, a `port` outside 1 to 65535, an empty value, and a key given more than once, which the spec forbids and which leaves nothing to believe, are each taken as not given. A value missing the part its Connection needs changes nothing, so a policy already held stays. Every `duration` is kept exactly, so its policy holds until `at` plus `duration`, as long as that fits in a safe integer of milliseconds. One beyond holds until the largest safe instant, so a policy never ends sooner than it says.
  - **Bounded and derived.** A policy is only ever for the host of the TLS Connection it arrived on, and an upgrade's `port` makes none, for that host or any other. So only hosts the Client dials, which come from the Owner's `ircds`, can have a policy, and the Owner's Configuration bounds them. The Owner is trusted ([ADR 0006](../../docs/adr/0006-proportionate-security.md)), so there is no further cap, and a policy that holds is never forgotten to make room. A policy that has expired is forgotten at the end of the step whose `at` finds it so, unless a Connection it covers is in progress. Policies are derived from journaled Lines, so replaying the Journal rebuilds them across a restart, and `Inspection.policies` shows them by host key.
- Scenarios: `sts.test.ts`, with a property test that, for any sequence of inputs, no `Dial` to a host is plaintext or on another port while a policy learnt over TLS holds for it, where what holds is worked out from the input Lines alone, by the spec, and never from what the Client reports, and a fresh-process replay with STS in play.

### SASL

- Needs: `sasl`, and a login in the Configuration. Without them, Self's account is unknown, except from a `900` or `901`.
- Changes: when the cap turns on during registration, sends `AUTHENTICATE PLAIN` and holds registration. On `AUTHENTICATE +` it sends the Credential as `SendSecret` `AuthenticatePlain`, with the account as both identities, and on `903` it lets registration go. It reads its replies only as they arrive live, never from history. `902` and `904` to `908`, a challenge `PLAIN` does not make, a `CAP NEW` that changes the `sasl` value so it no longer lists `PLAIN` before the Credential is sent, an `Unfilled` for the Credential, and the hold's 30 s deadline are a failed login, and all but the numerics abort with `AUTHENTICATE *`. A failed login lets registration go when the login is optional, and gives up the Connection with `LoginFailed` when it is required. When the cap lists mechanisms and `PLAIN` is not among them, it does not try, which is a failed login. A `903` before our `+` is taken as the Ircd's word, and no Credential is sent after it. A required login never goes unmet: while registering, when `sasl` is never offered, offered without `PLAIN`, refused, declined by the Owner, deleted before `903`, or the Ircd has no cap negotiation and answers `421` or goes straight to `001`, the Connection is given up with `LoginFailed`, and no Session is taken up. A `001` before `903` aborts with `AUTHENTICATE *` and does the same. `900` and `901` set Self's account. A `CAP DEL` for `sasl` after `903` changes nothing: Self is logged in, and the account stays known. A `CAP NEW` for `sasl` after `001` does not log in again.
- Scenarios: `sasl.test.ts`, and `login.test.ts` for the core's rule that a required login is never skipped, with or without the Feature

### Message tags

- Needs: `message-tags`. Without it, ids are unknown.
- Changes: a Line's `msgid` is the id of its Message or Activity, known from the Ircd. Tags the Client does not read stay on the Line, and client-only tags (`+…`) are reported with the Message. `@iirc/protocol` allows client-only tags on a Line we send, though nothing the Owner says carries one yet.
- Scenarios: `tags.test.ts`

### Server time

- Needs: `server-time`. Without it, a time is when the Line arrived.
- Changes: a Line's `time` tag is when its Message or Activity happened, known from the Ircd, and a topic's time with it. It is read without a clock or a time zone: `YYYY-MM-DDThh:mm:ss.sssZ`, with the milliseconds left out or to any precision up to nine digits, lower-case `t` and `z`, and a leap second, held at the last millisecond of its minute. A date that does not exist, any other form, or no `time` leaves the time of receipt.
- Scenarios: `tags.test.ts`

### Batches

- Needs: `batch`. Without it, no Line is in a batch.
- Changes: tracks open batches by reference, with the batch each opened inside, so a Line tagged with an open batch carries it to the later stages, and a batch may nest in another or interleave with it. Lines are read as they arrive, never held back, whatever the type, so a type the Client does not know changes nothing. Closing a batch closes any left open inside it. A `BATCH +` with no type, and a Line tagged with a batch never opened, are in no batch. At most 64 are open at once, and those that never close are dropped when the Connection ends, or when the cap is deleted and offered again.
- Scenarios: `batch.test.ts`, with a Feature of its own that treats each Line in a batch as history, to show the core's rule that history does not change the present

### Echoes

- Needs: `echo-message`, and uses `labeled-response` and the `batch` it depends on, as the spec says it must be negotiated. All three are asked for only together, and not when the Owner declined `batch`. Without all three, our Messages are not labelled, `ours.echo` is false, and nothing waits for an echo.
- Changes: each `Say` is sent with the next label of the Connection, `l1`, `l2`, and on, and its Message is reported at once with `ours.echo`. The count goes on through the Feature turning off and on again, so a late answer to a label given before is still matched, and never taken for one given since. The answer is the one Line with that label, or the batch whose `BATCH +` carries it, with any batch opened inside. Its first `PRIVMSG` or `NOTICE` from Self is the echo, reported as `Confirmed` with the Ircd's time, id, and final text, and the action's text for an `ACTION`. Its first error numeric, `FAIL`, or `ACK` is `Refused` as `Rejected`, with the numeric, the `FAIL`'s code, or `ACK`. A labelled Line that is neither, such as a `WARN`, ends the answer unconfirmed. Answers are matched by label, in any order, and each answers once. At most 64 labels await an answer, and past that the oldest is forgotten and stays unconfirmed, as one the Ircd never answers does. A Message Self sends to itself is told from its echo by the label. Each Line of an `Act` is labelled the same way, and its answer is only ever a rejection: its first error numeric or `FAIL` is `Refused` as `Rejected`, once for the action however many of its Lines are refused, each later one only using up its label, while an `ACK`, or a labelled Line on its own, such as the `TOPIC` the Ircd relays, ends the answer with nothing to report, and is read as any Line is. The pair is never kept without what labels need. When `echo-message` is enabled without `labeled-response` or `batch`, because the Ircd acknowledged only part or deleted one since, the Feature gives it up with `CAP REQ :-echo-message`, and until it is gone, a Message from Self is `Ignored` as `UnmatchedEcho`, since nothing can tie it to what we sent. When `labeled-response` is left without `echo-message`, the Feature is off, and gives it up the same way. `batch` stays, for the `batch` Feature.
- Scenarios: `echo.test.ts`

### Member prefixes

- Needs: `multi-prefix`. Without it, a member's prefixes are partial.
- A `PREFIX` that is malformed, such as one that repeats a mode or a symbol, as `(oov)@%+` does, reads as the default `(ov)@+`, as `@iirc/protocol/isupport` says, so a symbol only it named, such as `%`, is a prefix that cannot be named.
- Changes: a `NAMES` listing shows every prefix, in any order, so a member's prefixes are known, not partial. A symbol `PREFIX` does not name still stands for a prefix that cannot be named, so that member's stay partial. A set is known only while a Feature that makes it complete is on: when the cap is deleted, prefixes a listing made known go stale at once, and stay stale if it comes back, until something says them again. A `MODE` on stale prefixes gives what the floor would, partial: what they were, with the change. So does the next listing without the cap, and with it, they are known again. What the floor knew in full, a member listed with no prefix, stays known.
- Scenarios: `prefixes.test.ts`

### Away status

- Needs: `away-notify`. Without it, away status is known only from the `AWAY` Lines an Ircd sends anyway.
- Changes: the core reads `AWAY` Lines with or without the cap. With it, they keep away status up to date, so when the cap is deleted, every away fact goes stale until an `AWAY` says it again. Self's away status comes from `305` and `306`, the replies to our own `AWAY`, on the floor, and from Self's own `AWAY` when an Ircd sends one, as [Acting](#acting) says. A `305` or `306` is reported as Self's `AwayChanged`, timed by receipt, which belongs to the Network's own Timeline, as Self's own `AWAY` is, so a Frontend that never reads News learns from the projection that Self's away status changed.
- Scenarios: `away.test.ts`, and `acts.test.ts` for `305` and `306` reported

### UTF-8 only

- Needs: the ISUPPORT token `UTF8ONLY`. Without it, bytes that are not UTF-8 are read with the configured fallback.
- Changes: bytes are read as UTF-8 with no fallback, so a byte that is not UTF-8 becomes U+FFFD. Nothing leaves that is not UTF-8: text always is, a `Say` that cannot be is `Refused` as `Unsendable`, and a `PONG` echoing a `PING` token that is not UTF-8 is refused at egress, and not sent. A `005` that takes it back, or the Owner declining it, returns to the fallback.
- Scenarios: `utf8.test.ts`

### Recorded Ircds

- The four fixtures in `fixtures/transcripts/` replay through the Client with nothing `Ignored`: it registers, joins, and follows the Session. On Ergo, it logs in with SASL, reads times and ids from tags, and confirms our Messages by their labelled echoes. ngircd offers only `multi-prefix`, so that alone is on. `fixtures.test.ts` also folds two long scenarios again in a fresh process: one on the floor with reconnects and timers, and one with every Feature on.

## The test kit

`@iirc/client/testing` holds the transcript test kit, whose written interface is [its README](src/testing/README.md). A scenario is a transcript of IRC that `play` runs through a Client on a fake clock, matching every Line it sends, every `Ignored`, and each News written, and failing with a transcript diff. `replay` feeds a recorded fixture and reports what the Client did. After either, the kit replays the inputs and checks the Invariants "Plain data" and "Exact replay", and `replayFresh` checks them again in a fresh process. Preludes write registration and joins, and the four laws run over every set of caps `across` gives. It also holds `scripted(script)`, a Client that answers each expected input with set outputs and ignores anything else, for testing the Runtime without a real Client. Production code may not import `@iirc/client/testing`.
