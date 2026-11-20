# @iirc/client

The Client: iirc's pure understanding of one Network. It does no I/O and reads no clock. Every input carries its time, and every effect leaves as an output, so the same inputs always give the same states and outputs.

The Client is `client`, exported from `@iirc/client`. Its machines are reducers: the Network and its Connection, cap negotiation, Presence, the keepalive, and a keyed `Map` of Channels.

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

`State` is opaque. It is plain data, and is rebuilt by replaying the Journal.

### What the caller must do

- Journal each input before stepping it. Step inputs one at a time, in Journal order.
- Journal each step's outputs with its input, then carry them out in order.
- On restart, fold the Journal from `initial`, folding the timer table with `timers` as it goes, then set those timers and step a `Started`.
- Send `Configured` first. Until then, every other input but a `Look` is ignored.

## Inputs

Each input carries `at`, the instant it happened as the Runtime saw it.

| Input | From | Meaning |
| --- | --- | --- |
| `Started` | Runtime | The Runtime has started. A Connection the Client believed open is over. |
| `Configured` | Owner | The Network's whole Configuration. Joining, parting, and quitting are changes to it. |
| `Say` | Owner | Say something to a Target, with an intent id from the Runtime, and optionally the id of the Message it `answers`. |
| `Act` | Owner | Act on the Network, with an intent id: set a topic, kick, part a Channel Self is in (which leaves the Configuration alone, so a Channel it wants is joined again), change modes, invite, change Self's nick or realname, be away or back, send a CTCP request or a `PING` to a User, or send a Line written as text. |
| `Look` | Owner | Look something up, with an intent id: `Whois { nick }`, `Whowas { nick }`, a Channel's list, `Bans { channel }`, `Exceptions { channel }`, or `Invitations { channel }`, a Channel's members, `Names { channel }`, the Users a mask matches, `Who { mask }`, or the Channels on the Network, `Channels { mask?, least? }`. |
| `Retry` | Owner | Try connecting now, cutting a wait short. |
| `Removed` | Owner | The Owner removed the Network, keeping its Timelines readable or not, as `keep` says. |
| `Read` | Owner | The Owner has read a Timeline up to an instant: a Target's, or the Network's own. |
| `CloseTimeline` | Owner | The Owner closed a Target's Timeline: a Channel's Self is not in, or a Direct Message partner's. |
| `Opened`, `Received`, `Closed` | Transport | A Connection opened, one Line's bytes arrived, or a Connection is over, and how. |
| `Fired` | Clock | A timer the Client set is due. It consumes the timer. |
| `Unfilled` | Runtime | A `SendSecret` could not be filled, so nothing was sent. |
| `Unsent` | Runtime | Lines that never left, because their Connection ended first. |
| `Stopping` | Runtime | The Runtime is shutting down. |

### Configuration

`NetworkConfiguration` is the Schema of what `Configured` carries. It is also exported alone from `@iirc/client/configuration`, as pure data a Frontend may import.

- **A Frontend derives every option from the Schema alone**. Each field has a description and says what a new Network starts with, and each Credential field is marked as one. A field added here is an option there with no other work.
- **`credentialsOf(configuration)`** gives the names of the Credentials a Configuration names: its Ircd password, its login's, and each Channel's key.
- **`lines` are each parsed by the one rule `/quote` applies,** in `src/quoted.ts`. As a Session begins, after the welcome and any service login and before any Channel is joined, `userModes` go as one `MODE` on Self, then each Line in order, with no intent. One `/quote` would refuse in that moment, such as a `PART` of a Channel the Configuration wants, is `Ignored` as `Unsendable`.
- **A field added later decodes old Journals as the Client behaved before it,** so a Journal written before it still replays as it happened. That is usually what a new Network starts with, but `answerCtcp` and `whoOnJoin` start on and decode as off, since nothing was answered or asked then. `bot` starts and decodes as off, and Self sets the bot mode only where an Ircd names one.

### When the Client dials

- A `Configured` or `Started` with the Network enabled dials at once. There is no backoff before a first dial.
- After a `Closed` it waits on the backoff, then dials the next Ircd in `ircds`, round and round. `Retry` cuts the wait short.
- Disabling the Network sends `QUIT`, hangs up, and waits for the `Closed`. A `Removed` does the same, and nothing is dialled again, and each Lookup still waiting reports what it has in the removal's own step.
- A `Stopping` does the same, and then nothing is dialled and every `Say` is refused until the next `Started`.
- While an STS policy holds for a host, the dial is TLS on the policy's port, whatever Configuration says.

## Outputs

| Output | Meaning |
| --- | --- |
| `Dial` | Open a Connection to an Ircd, numbered by the Client from 1, never reused. |
| `Send` | Send an `OutboundLine`. It counts as sent unless an `Unsent` says otherwise. Every Line of a `Say` or an `Act` carries its intent, and a CTCP answer the request it `answers`. |
| `SendSecret` | Send a `SecretLine`. The Runtime fills in the Credential with `fillSecret` from `@iirc/protocol`. |
| `Hangup` | End a Connection. The Client still waits for its `Closed`. |
| `Wake` | Set a one-shot timer to an instant, or cancel it with `null`. The same id replaces the earlier one. |

The State holds no timer table. Each machine's state names the instants it waits for, and the table is derived from them. `timers(table, input, outputs)` folds one step of it, which the Runtime uses while replaying.

| Timer | Set while | When it fires |
| --- | --- | --- |
| `redial` | waiting after a `Closed` | dials the next Ircd |
| `register` | registering, 60 s from `Opened` | hangs up |
| `hold` | a Feature holds registration, 30 s | asks each holding Feature whether to go on |
| `keepalive` | in a Session | a `PING` after 60 s of silence, a hang-up after 90 s |
| `identify` | Channels wait on a service login, its `wait` | joins them |
| `rejoin <channel>` | a Channel is refused or kicked | joins it again |
| `lookup <intent>` | a Lookup awaits its reply, 30 s | reports what it has |
| `modes` | the Client's own `MODE` query awaits its answer, 30 s | asks the next Channel |
| `who` | the Client's own `WHO` query holds the slot, 30 s | asks the next Channel, still reading the last answer |

## News

News is what happened in one step, in order. It is derived, so replaying the Journal makes it again, and it is never journaled.

| News | Meaning |
| --- | --- |
| `Message` | Something said, with its time, id, whether it is `live`, a `highlight`, or Self's, the Owner's masks its sender `ignored`, and `where` it belongs. One we said carries `ours`: its intent, and whether the Ircd will echo it. It `answers` the id a `+reply` tag names, or the one Self's `Say` answered when the tag was sent, and a Direct Message carries the Channel a `+channel-context` tag names as its `context`. |
| `Confirmed` | The Ircd echoed back the Message for an intent, with its own time, id, and final text. |
| `Activity` | Something that changed, with its time, id, whether it is `live`, the masks the User behind it `ignored`, and `where` it belongs. |
| `SessionBegan`, `SessionEnded` | A Session's start and end, and why it ended. |
| `ConnectionFailed` | A Connection that ended before registration: why, the Ircd dialled, and whether it had opened. |
| `Refolded` | An Ircd declared another casemapping, so keys in `where` fold by it from here on. |
| `NetworkRemoved` | The Owner removed the Network, and `keep` is whether its Timelines stay readable. |
| `ReadMarker` | The Owner's Read Marker of a Timeline moved forward. |
| `TimelineClosed` | The Owner closed a Timeline, keyed as `where` keys it. The Client keeps nothing of it: whether a Timeline is still closed is the projection's to derive. |
| `Unignored` | The Owner took masks out of the Configuration's `ignores`, each given as every casemapping folds it. |
| `ChannelLearned` | A reply changed what is known of a Channel Self is in, which no Activity says: its modes or topic, the end of a `NAMES` listing, the end of a `WHO` answer that described its members, or a Line that gave a member's bot mark, or changed it. It says which Channel, keyed as `where` keys it. |
| `PartnerLearned` | Whether a Direct Message partner is on the Network, as `Knowledge.partners` says, changed with no Activity saying so: the first status `MONITOR` or `WATCH` gave, their joining or leaving a Channel Self shares, or the Session ending. It says which partner, keyed as `where` keys their Timeline. |
| `Refused` | A `Say` or an `Act` that was not carried out: `Offline`, `Unsendable`, for a ban by account `AccountUnknown` or `NoAccount`, `Rejected` by the Ircd with its numeric or code, or `Unsent`. |
| `LookedUp` | A Lookup is over, with its result. Exactly one comes for each `Look`. |
| `Ignored` | An input that changed nothing, and why. |

`@iirc/timelines` folds News into Timelines by these rules:

- **Our own Messages appear when we send them.** With `ours.echo`, a `Confirmed` follows when the Ircd echoes it, and the echo is not a second Message. With no echo it stays unconfirmed. If its Line never left, a `Refused` `Unsent` follows.
- **Order by time.** History arrives late, with `live` false. A Timeline orders by `at`.
- **One per id.** A Message can arrive live and again from history.
- **Self's own count as nothing unread.** A Message is `self` when Self said it, from here or from another IRC client, and is never a `highlight`.

### Where News belongs

Each Message and Activity carries `where`: the Timelines it touches, never none. The Client works it out from what it knows as the step begins, so a projection folds News without knowing the casemapping, Self's nick, or who shares which Channel.

| `where` | The Timeline |
| --- | --- |
| `Network` | The Network's own. |
| `Channel { key, name }` | A Channel's. |
| `Direct { key, name, existing }` | A Direct Message partner's. With `existing`, it touches only a Timeline that already exists. |
| `DirectRenamed { key, name, to }` | A partner changed nick: the existing Timeline takes the item and is keyed and named by `to` from then on. |

Every rule is decided from commands, parameters, `CHANTYPES`, `PREFIX`, and `STATUSMSG`, never from text. Names are read by one parser, in `src/names.ts`, whichever way a Line goes.

- **A Channel's name** starts with a character of `CHANTYPES`. **A nick** holds no space, `,`, `*`, `?`, `!`, or `@`, and does not start with `$`, `:`, a `CHANTYPES` character, or a membership prefix. `fixtures/nicks` holds these rules as data, which the web frontend's tests run too.
- **A Message to a Channel** belongs to the Channel, after any `STATUSMSG` prefixes, so `@#iirc` belongs to `#iirc`.
- **A Direct Message** belongs to the other participant, whichever way it went.
- **Any other Message** belongs to the Network: one from a server, to a mask, or to someone other than Self.
- **`Joined`, `Parted`, `Kicked`, `TopicChanged`, and a Channel's `ModeChanged`** belong to their Channel.
- **Another User's `Quit`, `NickChanged`, `AccountChanged`, `HostChanged`, or `RealnameChanged`** belongs to every Channel they shared with Self, and to their Direct Messages if those exist. `CameOnline` and `WentOffline` belong to their Direct Messages alone. A live rename moves the Direct Message Timeline. One from history renames nothing, since the old nick may be someone else's by now.
- **Self's `NickChanged`, `Quit`, `AwayChanged`, `AccountChanged`, `HostChanged`, and `RealnameChanged`** belong to the Network, the first two to every Channel Self is in as well.
- **A list of Targets is never one Timeline.** Each item is placed by itself, and a `Say` to a list is `Unsendable`.
- **History is placed as the present is,** by what is known as it arrives.

Keys fold by the casemapping the Network last declared, on any Connection, and `rfc1459` until one has. So a Timeline keeps its key across Connections. When an Ircd declares another, a `Refolded` reports it before any News keyed by it, and a projection folds its Timelines' names again.

A `Refused` for an `Act` names no Message, so it carries `action`: what was tried and the one Timeline it belongs to.

- **What was tried is the action's kind and the names the Owner gave it.** No topic, reason, away message, or mode parameter is in it, so a Channel key given with `+k` never is.
- **It belongs to the Channel the action was about,** when the Client held that Channel, and otherwise to the Network's own.

## Knowledge

`known(state)` gives Channels, members, Users, Self, the open Direct Message partners, and where the Session is.

- **Keys fold by the Connection's casemapping,** which starts from `rfc1459` on each Connection. When it changes, every key is folded again. `declared` gives the mapping `where` folds by, and `chantypes` the Session's `CHANTYPES`, so a Frontend compares and prefixes Channels' names as the Network does.
- **Users are those who share a Channel with Self, and Self,** and while a Feature keeps them, those `MONITOR` or `WATCH` says are online. What was seen of a User is forgotten once they are neither.
- **`partners` are the open Direct Message partners,** keyed as `where` keys their Timelines, and whether each is `here`: known true while they share a Channel with Self or `MONITOR` or `WATCH` says they are online, known false while it says they are offline, and unknown otherwise, as with no Session.
- **Self's away status is as the Ircd confirmed it,** never as the Owner asked.
- **A Channel's `wanted` says whether the Owner wants Self in it.**
- **A User's account is `null` when known to be logged out, and `Unknown` when not known.** Another User's is learned only from the caps below, a `WHOIS`, or the `WHO` asked on joining.

Every fact is a `Fact<T>`:

| Case      | Means                                      |
| --------- | ------------------------------------------ |
| `Known`   | True as of `at`, from a source             |
| `Partial` | A set with at least these members          |
| `Stale`   | Was true, and is no longer kept up to date |
| `Unknown` | Nothing has told us                        |

A fact's source is `ircd`, `replied`, `receipt`, or `ours`. Nothing in Knowledge names a cap or a Feature. A View learns how a fact is known, never why, so a new Feature changes which case a fact lands in and not the View's code.

`channel(state, name)` gives one Channel: its members as Users, and the Network's `PREFIX`, `CHANMODES`, and `CHANTYPES`, with the protocol's defaults until an Ircd says. It costs what the Channel holds, where `known` builds every Channel and User. A View that finds a Channel from its Timeline passes the Timeline's name, not its key, since the two may fold by different mappings early in a Connection.

## Inspection

`inspect(state)` gives what Views do not need: each machine's state, the Connection, the caps offered and enabled, ISUPPORT, the STS policies by host, the Features on, and the timer table.

| Machine | States |
| --- | --- |
| `network` | `Unconfigured`, `Idle`, `Waiting`, `Connection.Dialing`, `Connection.Open`, `Connection.Closing` |
| `caps` | `Listing`, `Requesting`, `Holding`, `Ready.Steady`, `Ready.Changing`, `None` |
| `presence` | `Registering`, `Session` |
| `keepalive` | `Listening`, `Pinged` |
| `modes` | `Asking` |
| `who` | `Asking` |
| `channel <name>` | `Wanted`, `Joining`, `Joined.Syncing`, `Joined.Synced`, `Refused`, `Kicked` |

A machine that is not running is left out.

## Invariants

- **Pure.** `step` reads no clock, randomness, locale, or time zone, and does no I/O.
- **Plain data.** State holds only strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. It never holds a `HashMap` or `HashSet`, because Effect hashes by reference with `Math.random`, so their order could differ on replay.
- **Total.** `step` never throws, for any input in any state.
- **Exact replay.** Folding the Journal's inputs from `initial` gives the same states, outputs, and News.
- **Time comes from inputs.** Every `Wake` instant is computed from an input's `at`. A `Fired` from an earlier setting of a timer is stale and ignored.
- **Hardened, not tuned.** The Client accepts anything the protocol allows, from any Ircd. Ergo and ngircd show where Ircds differ and are never the cases to code for. What it cannot read is `Ignored`, never fatal.
- **Decisions come from structure.** Commands, numerics, tags, and parameters decide. An Ircd's free text never does.
- **One Connection at a time.** Once the Client has begun to hang up, it sends nothing more on that Connection.
- **Credentials appear only by name.** No input or output holds a Credential's value.
- **Never insecure under STS.** Once an Ircd has given a policy over TLS, the Client dials that host only over TLS until the policy expires, and never falls back to plaintext.
- **A required login is never skipped.** A Session begins only if the Configuration does not require a login, or a `903` arrived on this Connection. The core holds to this itself, whatever the Features do.
- **History does not change the present.** A Line that is not `live` is reported as News and changes nothing that is known now.
- **A step costs what its Line touches,** never every member of the Network. A Message costs the same in a Channel of ten as in one of 10,000. `bun run bench:scale` prints what each step costs.
- **Bounded.** Everything held from Ircd input has a bound, so a hostile Ircd can make facts unknown but cannot make the state grow without limit.

## Error modes

| Input | What happens |
| --- | --- |
| Bytes that do not parse | `Ignored` with `Unparseable`. The Connection stays up. |
| A Line whose parameters do not fit its command | `Ignored` with `Malformed`. |
| A tag value that does not parse | The fact keeps its default, such as the time of receipt. |
| Input from an old Connection, or a stale `Fired` | `Ignored` with `StaleConnection` or `StaleTimer`. |
| An input or a Line that makes no sense now, such as a second `001` | `Ignored` with `NotNow`. A Line the Client does not read is not an error. |
| An Owner intent that cannot be carried out | `Refused` with the intent id. It is not queued. |
| A `Read` or a `CloseTimeline` whose Target names no one Timeline | `Ignored` with `NoTimeline`. |
| A `CloseTimeline` of a Channel Self is in | `Ignored` with `Joined`, naming the Channel as resolved, without a status prefix. |
| A Line a Feature refuses at egress | A `Say` is `Refused` with `Unsendable`. Any other is `Ignored`. Nothing is sent. |
| `Unsent` | A `Say` or an `Act` whose Line is among them is `Refused` with `Unsent`, once. A CTCP answer among them, from any Connection, is a `CtcpUnsent`, where its request is. |
| `Unfilled` | SASL counts it as a failed login. A service login's Channels are joined at once. An `OPER` awaits no answer. A Channel whose key is unfilled is refused. Registration goes on without `PASS`. |
| A Feature hook that throws | That Feature is off for the rest of the Connection, and `Ignored` with `FeatureFailed` records it. |

## The Feature seam

A Feature brings one IRCv3 cap or ISUPPORT token, or a tight group of them, to the Client. The seam is internal: Features are tested only through `step`. The types are in `src/feature.ts`, and `src/features/` holds the Features, of which `multi-prefix` and `server-time` are the shortest to read first.

- **On and off.** A Feature is on while every cap it `needs` is enabled and every token is in ISUPPORT, and the Feature's `accepts`, if it has one, says yes to what ISUPPORT holds, unless the Owner declined it.
- **Asking.** A Feature's caps are asked for together, and only when every one is offered.
- **Stages.** Ingress runs `tags`, then `batch`, then `label`, then `react`, then `meaning`. Egress runs `egress`. Within a stage, Features run in the order of the registry in `src/registry.ts`.
- **Refining, not branching.** A hook takes what the core derived and returns it refined, in the core's own vocabulary. The core never asks which Feature produced it.
- **Only `react` acts,** and only on a live Line. The other ingress hooks refine, and the core discards anything else they ask for. So nothing from history sends a Line or decides registration.
- **Effects are returned.** A hook may return its new state, Lines to send, caps to drop, and a say over registration: `Hold`, `Continue`, or `Abandon`.
- **Features set no timers.** The core keeps one deadline while any Feature holds registration, and asks each what to do when it passes.
- **Turning off marks stale the facts only that Feature kept,** such as away status without `away-notify`.
- **A hook reads a narrow, constant-time part of Knowledge,** so the Features cost a step the same however large the Network is.
- **The core places News.** No Feature works out `where`.

STS is not a Feature. Its policy outlives Connections and decides where to dial before any cap is negotiated, so the core keeps it, in `src/sts.ts`.

## Features

Each is built from the floor up: what it needs, what it changes, and its scenarios, which play strictly through `step` in `src/scenarios/`.

### The floor

These need nothing from the Ircd beyond RFC 1459 and 2812.

- **Connecting and redialling** (`connection.test.ts`). The backoff is 2 s doubling to 5 minutes, and starts again after a Session that lasted 5 minutes. It takes no randomness, since one Daemon serves one Owner and there is no herd to spread out.
- **Registration** (`registration.test.ts`, `reclaim.test.ts`). Sends `CAP LS 302`, `PASS` when configured, `NICK`, and `USER` at once. An Ircd with no cap negotiation answers `421` or goes straight to `001`. When a nick is taken, it offers the configured nicks in order, then the first with `_`, `2`, `3`, and on, within `NICKLEN`. Self takes the first configured nick back when it holds another it settled for and sees that nick's holder leave it, by a `QUIT` or by a `NICK` to another nick (not a change of case), or `MONITOR` or `WATCH` reports it offline, and then asks once: a refusal is not retried until the holder is seen to leave again, nothing polls, and nothing is taken back for the rest of a Session once the Owner sets a nick with a `NICK`, or once the Network renames Self off the first nick with no `NICK` of ours asking, as services do. Without either, Self sees only the holders it shares a Channel with. The ask's answer is never taken for an answer to the Owner's own `NICK`. It is Activity like any other change of Self's nick.
- **The Session and ISUPPORT** (`session.test.ts`). `001` begins a Session. ISUPPORT accumulates over every `005`, at most 256 tokens. Self's mask is never read from `001`, whose text is for people.
- **A service login** (`service-login.test.ts`). With a `Service` login, each Session begins by telling the service `IDENTIFY <account> <credential>` in a `PRIVMSG`, and its Channels wait. A `900`, which also makes Self's account known, lets them be joined, and so do the Configuration's `wait` running out, an unfilled Credential, and a Configuration with no service login. No user mode counts, since none means logged in across the protocol: RFC 2812's `r` is "restricted". A `NOTICE` from the service never counts, whatever it says. The Credential is never told while the Ircd may echo it back to be journaled: a service login stops `echo-message` being asked for on later Connections, and a Session that finds it on or asked for at `001`, because the login was configured while registering, tells nothing and joins at once. A Connection that has it keeps the Feature on, so each echo is still matched to its Message.
- **What an Ircd says** (`numerics.test.ts`). A live numeric that nothing else reports, such as the welcome, the counts of Users, or a `422`, is a `Numeric` Activity in the Network's own Timeline, by its number and its parameters after the one that names Self, as they came. One collected for a Lookup, tied to an action, or answering the `MODE`, `WHO`, `NICK`, `OPER`, or `CAP LS` the Client sent, is not shown, nor is one the Client reads or reports otherwise, which `unshown` in `src/lines.ts` lists by number.
- **The message of the day** (`motd.test.ts`). The `372` Lines between a `375` and a `376` are one `Motd` Activity in the Network's own Timeline, each line's text as it came, shown when the `376` comes. It is collected by those numerics alone, live and untied as a shown numeric is, so a `372` or `376` outside one shows as any numeric does, and a `422` too. It is bounded at 200 lines: the next line shows it `cut`, and the rest is dropped until its `376`. The next `375`, or the Connection ending, before its `376` shows it `cut` with what it has.
- **An operator login** (`oper.test.ts`). With an `oper` login, each Session begins by sending `OPER <name> <credential>`, and awaits the answer, read from its numeric alone: `381` is an `OperGranted`, and `464`, `491`, or a `461` naming `OPER` an `OperRefused` with that numeric, each once, in the Network's own Timeline. A numeric when nothing awaits it is no answer, and is shown as it came. `echo-message` never echoes `OPER`, so no cap is declined for it.
- **Keepalive** (`keepalive.test.ts`). Answers `PING` at once, byte for byte. After 60 s of silence it sends a `PING`, and after 90 s it hangs up.
- **A Channel's modes** (`modes.test.ts`). Each time Self's join is confirmed, the Client asks the Channel's modes once with `MODE <channel>`, and folds the `324` that answers. One query waits at a time on a Connection, so a hundred Channels are asked one after another, each when the last is answered or after 30 s, and the Owner's Lines never queue behind them all. A Channel whose modes are already known by its turn is not asked. An error in answer leaves the modes unknown. A `MODE` while they are known keeps them true, by `CHANMODES`, with `PREFIX`'s modes as membership; one while they are unknown leaves them unknown, never a partial set. A key is kept only as set.
- **Who is in a Channel** (`who.test.ts`). With the Configuration's `whoOnJoin`, once the `NAMES` listing that follows Self's join ends, the Client asks `WHO <channel>` once a Session, never again in it though Self joins again, one Channel at a time as for `MODE`, independently of it. With `WHOX` it asks `%tcuhnfar` with a token of its own, and reads only a `354` that carries it, an account of `0` meaning logged out. Without it, a `352` gives the mask, realname, and away status, and no account. Either is read while it names a Channel asked whose answer has not ended, and refreshes only a member the Client keeps, never Self, as the latest word on them. `G` is away, `H` here, the mode `BOT` names among the flags after it a bot, and its absence not one, and since WHO gives no away message, an away member keeps the message already known, or none. The Runtime may send the `WHO` after Lines the Owner asked for later, so it waits among none of them: it takes no error numeric naming its Channel, only a `421` or `461` naming `WHO`, or a `FAIL` of `WHO`, which end its answer, as do its `315` and an `Unsent` of it. After 30 s the next Channel is asked, and the late answer is still read until its `315`. No Activity is reported, only a `ChannelLearned` when an answer that described anyone ends.
- **Channels** (`channels.test.ts`). Each Channel the Owner wants is a machine. Wanted Channels share `JOIN` Lines as `TARGMAX` allows, and one with a key goes alone. A refused Channel, a kick, or a `PART` the Owner did not ask for is joined again on the backoff. A Channel Self was put in without asking is followed with `wanted` false and never joined again. Without `multi-prefix`, a member's prefixes are partial.
- **Messages and Activity** (`messages.test.ts`, `where.test.ts`). `PRIVMSG` and `NOTICE` are Messages, and a CTCP `ACTION` an action. A `DCC` is dropped, and other CTCP is Activity, below. `JOIN`, `PART`, `QUIT`, `NICK`, `KICK`, `TOPIC`, `MODE`, and `AWAY` are Activity, and so is a standard reply that refused nothing. An `INVITE` that names Self is an `Invited`, by who invited and to which Channel, in the Network's own Timeline (`invite.test.ts`). One that names another User is not reported. A `Say` that the Ircd would cut short relaying it is `Unsendable`, never truncated.
- **CTCP** (`ctcp.test.ts`). A CTCP in a `PRIVMSG` from another User is a `CtcpRequest`, with what became of it, and one in a `NOTICE` a `CtcpReply`. Self answers a live `VERSION` (`iirc`, and nothing of what it runs), `PING` (its arguments, back), `TIME` (when the request arrived, in UTC), and `CLIENTINFO` with a `NOTICE` to the sender's nick, never to a Channel or a mask, and answers nothing when the Configuration's `answerCtcp` is off. Answers take a budget of three at once and then one every ten seconds, which reconnecting does not refill. A request that is not answered says why, and none is dropped. A request or a reply belongs to each Channel it was sent to, and otherwise to the Network, and to the sender's Direct Messages if those exist. A live reply to Self, never to a Channel, with the token of a `PING` the Owner sent, from the User it went to, carries `roundTrip`: the milliseconds between the instants the Runtime journaled the request and the reply, and every other reply carries `null`. The User a `PING` went to is followed through a change of nick, and the `PING` is forgotten when that User quits or another User takes the nick. An answer that never left is a `CtcpUnsent`, in the Timelines its request is in as they stand then: its Channels as named when it arrived, or its partner's Direct Messages as they followed a live rename. Once another User took that nick, or 64 later answers have pushed it out of memory, it goes to the Network's own Timeline alone, never another User's. Its budget stays spent.
- **Read Markers** (`read.test.ts`). A `Read` moves one Timeline's Read Marker forward, never back, so two Frontends marking at once cannot undo each other. It needs no Session, and markers outlive Connections.
- **Closing a Timeline** (`close.test.ts`). A `CloseTimeline` names a Channel or a Direct Message partner as a `Read` does, never the Network's own, and is reported unless Self is in that Channel now. It needs no Session.
- **Highlights** (`highlight.test.ts`). A live Message from another User is a Highlight when it holds Self's nick, or one of the Configuration's `highlights`, as a whole word. Word boundaries use Unicode 17.0, pinned in `src/word-characters.ts`, so a Journal gives the same Highlights on every runtime. The search is linear in the text, however hostile.
- **Ignoring by mask** (`ignore.test.ts`). The Configuration's `ignores` are `nick!user@host` masks, at most 64. A Message or an Activity from a User one of them matches, by its source, carries those masks as `ignored`, folded by the casemapping the Network last declared and each once, in the Configuration's order, and one that matches none carries nothing. The one who joined, quit, or set a mode is the User, and so is the one who kicked, not the one kicked. A `HostChanged` is stamped by the mask the User had or the one they have now. History is stamped as live is, and a Message from the Ircd or another server never is. Self is never ignored, whatever the masks. The Client drops nothing and counts nothing: a projection hides what is stamped, and shows it again on `Unignored`, which a Configuration that no longer holds a mask gives, with the mask as every casemapping folds it, less any fold a mask still held shares, so a stamp made under another mapping is found. An ignored User's Direct Message opens no partner to monitor. A mask respelt in another case is the same mask. A CTCP request from an ignored User is stamped, and is still answered.
- **What is ignored** (`ignored.test.ts`). Nothing unreadable ends the Connection.

### Acting

`acts.test.ts`. An `Act` sends what the Owner asks, built only through `@iirc/protocol`'s builders and checked first against what the Client knows of the Network. A Line that cannot be sent whole is `Unsendable`, never cut short.

- **`Topic`, `Kick`, `Invite`, and `Nick`** are checked against `TOPICLEN`, `KICKLEN`, `NICKLEN`, and `TARGMAX`.
- **`Setname`** changes Self's realname for the Session with `SETNAME`, where the Network offers `setname` and it is enabled now, and is `Unsendable` otherwise, when the realname is empty or longer than `NAMELEN`, or when the Line does not fit as the Ircd relays it. The Ircd's `SETNAME` back, or a `FAIL` of it, answers it, and Self's realname is what that says.
- **`Mode`** gives each change a parameter exactly as `PREFIX` and `CHANMODES` say, and splits across Lines by `MODES`. A mode neither names is `Unsendable`.
- **`BanAccount`** bans a User from a Channel by the account the Client knows, as `MODE <channel> +b <mask>`, where the Network's `EXTBAN` and `ACCOUNTEXTBAN` say how a ban names an account and `CHANMODES` lists `b`. It is `Unsendable` when either token is missing or malformed, or when the mask cannot name that account exactly. It is `AccountUnknown` when nothing known says which account the User holds, including a User the Client has not seen, and `NoAccount` when they are known to be logged out, and never falls back to a mask of their nick. It is reported as a `Mode` of `+b` on its Channel. A Channel's view says `accountExtban` for a Frontend to offer it.
- **`Away`** describes the Owner, so it outlives Sessions and is sent again as each begins. It is the one action that needs no Session.
- **`Ctcp` and `Ping`** send a CTCP request in a `PRIVMSG` to one User, never a Channel, a `STATUSMSG` Target, a list, or a mask, and are reported as a `CtcpSent` where that User's replies go. `Ctcp` sends its command upper-cased, with its arguments as given, and never `ACTION`, which is a `Say`, or `DCC`. `Ping`'s token is the instant it was sent, in milliseconds, and after a hyphen how many `PING`s were sent before it on the Connection, so no two on a Connection share one. Each `PING` is remembered on the Connection, at most 64, so its reply tells its round trip. Nothing waits on a reply: no timer is set, no error numeric is tied to the request by its parameters (only its label can refuse it), the oldest is forgotten past the bound, and the rest end with the Connection.
- **`Part`** parts one Channel the Configuration does not want, such as one the Ircd put Self in. A Channel the Configuration wants is `Unsendable`, since parting it is a change to the Configuration, as for `Raw`. Self's own `PART` of the Channel answers it.
- **`Raw`** sends a Line written as text. It may not be `CAP`, nor `PASS`, `AUTHENTICATE`, or `OPER`, which carry a Credential. `OPER` is configured instead. A `JOIN` or `PART` of a Channel the Configuration wants is refused, since those are changes to the Configuration. The Client follows whatever the Ircd echoes back, as if another IRC client of the same account had sent it.
- **A refusal is tied to its action by structure.** With `labeled-response`, by label. On the floor, an error numeric is tied to the oldest Line of an action that names what the numeric names, such as `482` by its Channel. The Client's own `MODE` query of a Channel waits among them in the order it was sent, and takes a `324` of its Channel, an error numeric naming its Channel, or a `421` or `461` naming `MODE`, when it is the oldest.
- **Some refusals cannot be tied on the floor:** a numeric that names nothing the action named, and anything an Ircd says only in text. A `472` names a mode, so it ties to the oldest `MODE` that changes that mode, or a list Lookup asked by it, whichever was sent first.

### Lookups

A `Look` asks the Network something and collects the reply, which may span many Lines, into one `LookedUp`.

- **Every `Look` gets exactly one result:** `Found` or `Partial` with the Users a `WHOIS` or `WHOWAS` described, `Listed` with a Channel's masks, `Members` with the members a `NAMES` listed, `Users` with the Users a `WHO` described, or `Channels` with the Channels a `LIST` described, each of the last four with why it was cut short, if it was, `NotFound`, `Failed`, `Refused`, or `Unsent`.
- **A `NAMES` takes a Channel's name by the Network's rules, and a `WHO` one mask,** asking no WHOX fields. A `NAMES` collects its answer into a listing of its own, never the Channel's, and replaces the members of a Channel Self is in with it only when its `366` comes, even past the bound of what it reports. One whose time runs out reports what it has, and reads on until its `366` or its labelled answer's end. An answer over without its `366` corrects nothing and leaves nothing for another listing to keep, and a labelled one that ends without its `366` or `315` is cut short as `Ended`.
- **A Channel's list is asked by the mode ISUPPORT gives it.** Bans are `b` while `CHANMODES` lists it. Exceptions and invitation masks are the modes `EXCEPTS` and `INVEX` name, `e` and `I` when they name none, offered only when the token is sent and `CHANMODES` lists the mode as a list. One the Network does not offer is `Refused` as `NotOffered`, and nothing is sent. Each mask keeps who set it and when, where the Ircd says.
- **A `LIST` is the Channel directory.** It asks only what the Ircd's `ELIST` offers, by letters in any case, as one parameter: the mask by `M`, unless it starts with `!`, which an Ircd with `N` reads as its negation, and the least members by `U`, as `>N` for one fewer, so `>0` for at least one. What the Ircd is not asked the Client filters itself, the mask as a glob of `*` and `?` folded by the Network's casemapping. A mask that is empty or holds a comma or a space is `Unsendable`. Each `322` that names a Channel by the Network's rules with a count of digits is seen, and any other is `Malformed` and skipped. It keeps the 1000 Channels with the most members as it reads, most first, then by name, so a reply of any length is held in bounded memory, and none of it counts against the Lines a Lookup keeps. Its result says how many it saw, and is `Bounded` only when that is more than it kept, never for its notes.
- **One `LIST` at a time, tied by structure alone.** It is never labelled, since its answer may outlast the labels awaited. Its `321`, `322`, and `323` name nothing it asked, so they are never part of another Lookup's reply, and a second `LIST` while one awaits is `Refused` as `Busy`, and nothing is sent. Before its rows begin, a `263` or `421` naming `LIST`, or a `FAIL` of `LIST`, ends it at once. Once a `321` or `322` has come, only its `323` or its Connection's end does: a later `FAIL` is kept in its notes, and any other numeric is read as it is elsewhere. One whose time runs out reports what it has, and reads on, keeping nothing, until then, still holding off another.
- **A reply is collected by structure.** With `labeled-response`, by its label. On the floor, a numeric belongs to the oldest Lookup whose nick, Channel, or mask it names, or to an action or the Client's own `MODE` query sent before it that it names, as with `482`. A `421` or `461`, and a standard reply, name a command instead, and go to whichever sent with that command was sent first. A `352` names no mask, so it goes to the oldest `WHO` Lookup, except that one naming a Channel whose `WHO` on joining is still answered goes to that answer alone, unless the Lookup asked that Channel.
- **Only reply numerics and standard replies are read.** A numeric the Client does not model is kept as it came, so nothing is lost. A `FAIL` ends the Lookup by its code, at once when it was sent without a label, since nothing promises an end numeric after one, and so does an error numeric that refuses a list, a `NAMES`, or a `WHO`. A `WARN` or `NOTE`, and each `FAIL` after the first, is kept in the result's `notes`. Nothing is read from free text but the one mode word of a `379`. A `335` says the User is a bot only where the Ircd names a bot mode, since Ircds used it for other things before, and is kept as it came where it names none.
- **Bounded.** At most 8 await their replies on a Connection, at most 64 Lines of one are kept, besides at most 500 members or Users, or 1000 Channels, and one with no end within 30 s reports what it has.
- **A `WHOIS` refreshes only what the Client already models,** and never undoes something said since. The Client never sends a Lookup itself, so nothing is polled.

### Standard replies

`standard-replies.test.ts`. `FAIL`, `WARN`, and `NOTE` are read by structure: the command they are about, their code, their context, and their description, each its own field. Nothing is decided from the description.

- **One that answers something Self sent is shown with it.** By label where there is one: where the `Say`'s Message stands, where the action belongs, or on the Lookup's result, including what follows the echo in the same answer. On the floor, by the command it names, to the oldest Line of an action or Lookup sent with that command. One that names `PRIVMSG` or `NOTICE` goes to the latest `Say` of that command sent on the Connection without a label: its Channel, or its Direct Message partner. Without labels nothing says which Message it answers, so that is a guess. The Client keeps only that Target for each command, forgets it when the Connection ends, and moves it when the partner changes nick, as the Timeline moves. It forgets it when another partner takes that nick, since the Timeline there is detached, so a reply is never shown in someone else's Timeline, and falls to the Network's own.
- **A `FAIL` refuses.** One that answers an intent by label, or an action by its command, refuses it with its code, as an error numeric does. An intent is refused once: each later `FAIL` for it refuses nothing, and is shown where it belongs, as is one tied to a `Say` by the guess. A `WARN` or `NOTE` settles nothing, so a later answer still counts.
- **The rest are Activity in the Network's own Timeline,** a `FAIL` that refused nothing included, and every one from history. None is dropped.

### With caps

| Feature | Needs | Changes | Scenarios |
| --- | --- | --- | --- |
| Cap negotiation | caps from the Ircd | Asks for each Feature's caps, whole or not at all. Only what the Ircd acknowledges is enabled. `CAP NEW` and `CAP DEL` are followed for the rest of the Connection. | `caps.test.ts` |
| SASL | `sasl`, and a SASL login in the Configuration | Logs in with `PLAIN`, holding registration until `903`. A failed login goes on when it is optional, and gives up the Connection with `LoginFailed` when it is required. | `sasl.test.ts`, `login.test.ts` |
| Message tags | `message-tags` | A Line's `msgid` is its Message's id. Client-only tags are reported with the Message, and `+reply` and `+channel-context` are read, ignored where their specs say. A `Say` that `answers` a Message is sent with `+reply` where the Session has `message-tags`, and without it, still said, where it has not. Knowledge says which, as `tags`. | `tags.test.ts`, `replies.test.ts` |
| Server time | `server-time` | A Line's `time` tag is when it happened. Without it, or when malformed, the time is when the Line arrived. | `tags.test.ts` |
| Batches | `batch` | Tracks open batches, nested or interleaved. Lines are read as they arrive, never held back. | `batch.test.ts` |
| Echoes | `echo-message`, `labeled-response`, and `batch`, only together | Each `Say` is labelled, and its echo is `Confirmed`. An error in its answer is `Rejected`, and a `WARN` or `NOTE` in it is shown where the Message stands. | `echo.test.ts` |
| Standard replies | `standard-replies` | Asks for the cap, so the Ircd may send any well-formed `FAIL`, `WARN`, or `NOTE`. They are read whether or not it was asked for. | `caps.test.ts`, `standard-replies.test.ts` |
| Member prefixes | `multi-prefix` | A `NAMES` listing shows every prefix, so a member's prefixes are known, not partial. | `prefixes.test.ts` |
| Away status | `away-notify` | Away status is kept up to date, and goes stale when the cap is deleted. | `away.test.ts` |
| Account tags | `account-tag` | A User's Message or Activity without an `account` tag says they are logged out, and with one, their account. A tag with no value says nothing. | `accounts.test.ts` |
| Account changes | `account-notify` | An `ACCOUNT` Line is `AccountChanged` Activity, `*` meaning logged out, and Self's is Self's own account. Accounts go stale when the cap is deleted. | `accounts.test.ts` |
| Extended joins | `extended-join` | A `JOIN` with an account and a realname sets both, `*` meaning logged out. | `accounts.test.ts` |
| Host changes | `chghost` | A `CHGHOST` Line is `HostChanged` Activity, with no quit or join, and changes the User's mask, or Self's. Its ignore stamp holds the masks the User matched by the mask they had or the one they have now, and the Lines they send after carry the new source. A `CHGHOST` that is not from a User's whole mask with exactly two parameters that make a mask is `Malformed`, and changes nothing. Masks go stale when the cap is deleted. | `masks.test.ts` |
| Masks in names | `userhost-in-names` | A name in a `NAMES` listing may be `<prefixes>nick!user@host`: the member's nick is the bare one, and their mask is known at once. A name with a `!` or an `@` that does not split into a nick, user, and host adds no member. It runs after `multi-prefix`. | `masks.test.ts` |
| Realname changes | `setname` | A `SETNAME` Line is `RealnameChanged` Activity and changes the User's realname, or Self's. One not from a User's whole mask, or without exactly one non-empty realname, is `Malformed`. Realnames go stale when the cap is deleted. The Owner's `Setname` needs it. | `masks.test.ts` |
| Extended monitor | `extended-monitor` | A User `MONITOR` says is online is kept as one in a shared Channel is, so `AWAY` and `ACCOUNT` keep their facts and `730` their mask. They go stale when the cap is deleted. | `monitor.test.ts` |
| Bot mode | the ISUPPORT token `BOT`, as exactly one letter | A User's Message or Activity with a `bot` tag, of any value, says they are a bot, and marks the Message `bot`. While the Session carries tags, one without it says they are not. Each time that changes what is known of a User, the Client reports every Channel Self is in with them as learned, since a bot mark is no Activity. A `MODE` on Self that sets or unsets the mode says whether Self is one. With the Configuration's `bot`, Self sends `MODE <self> +<mode>` once a Connection, as the token is first known in a Session. Whether a User is a bot goes stale when the token is taken back. A `BOT` of anything but one letter is no bot mode, also when it replaces a good one: the Feature is off, no one is marked, and nothing is sent. | `bot-mode.test.ts` |
| UTF-8 only | the ISUPPORT token `UTF8ONLY` | Bytes are read as UTF-8 with no fallback, and nothing leaves that is not UTF-8. | `utf8.test.ts` |

`seam.test.ts` drives each stage of the seam with Features of its own, and `laws.test.ts` runs the four laws over every Feature in the registry.

### Presence, with MONITOR or WATCH

`monitor.test.ts` and `watch.test.ts`. Where ISUPPORT offers `MONITOR`, the Client monitors the Users it cares about. Where it offers only the older `WATCH`, the same list is kept through that, and a Frontend sees exactly the same: only the Lines differ. Where it offers both, `MONITOR` is used, and a list `WATCH` kept before a later `005` offered `MONITOR` moves to it whole. Without either, nothing is sent or reported.

- **The list is derived, in a stated order:** the first configured nick while Self would take it back, then each open Direct Message partner, most recently messaged first. It is cut to the command's limit, and to 256 partners, then less what a `734` or `512` refused on the Connection, which is never sent again there. Self is never on it.
- **The partners are folded from the Client's own News,** as a projection folds Timelines: a Direct Message adds a partner, a live rename moves them, closing their Timeline removes them. Replaying the Journal rebuilds them.
- **Only the difference is sent,** as `MONITOR -` then `MONITOR +`, or `WATCH -nick` then `WATCH +nick`, as few Lines as fit, `TARGMAX` allows, and a Line has parameters for, after a step that may change the list. Each Connection starts with nothing sent, so each Session sends it whole once its `005` offers the command. Nothing polls.
- **`730` and `731` say who is online,** as `604` and `600`, and `605` and `601`, do for `WATCH`, whose numerics are read only while it keeps the list. The first word on a nick after it is added is learned silently. Only a change from what the Connection knew is Activity, `CameOnline` or `WentOffline`, and only for a partner. A `QUIT` or rename seen in a shared Channel is that change already, so the word after it tells nothing again.
- **A refusal ends it for the Connection:** a `421` or `461` naming the command, or a `FAIL` of it. Nothing is retried.

### Strict Transport Security

`sts.test.ts`. It needs the `sts` cap's value, which the core reads from every `CAP LS` and `CAP NEW`. The core never asks for the cap, since the spec forbids it.

- **Learning.** Over TLS, a `duration` stores a policy for the Connection's host, on this Connection's port. `duration=0` removes it.
- **Upgrading.** Over plaintext, a `port` ends the Connection and dials the same host over TLS on that port at once. If that TLS fails, it is never retried in plaintext.
- **Dialling.** While a policy holds for a host, every dial to it is TLS on the policy's port.
- **Hosts.** Policies are keyed by DNS name. An IP literal never gets one, since TLS sends no name for it.
- **Derived.** Policies come from journaled Lines, so replay rebuilds them across a restart. Only hosts in the Owner's `ircds` can have one.

### Recorded Ircds

The fixtures in `fixtures/transcripts` are real Sessions on Ergo and ngircd, and replay through the Client with nothing `Ignored`.

## The test kit

`@iirc/client/testing` holds the transcript test kit. A scenario is a transcript of IRC that `play` runs through a Client on a fake clock, failing with a transcript diff. After each, the kit replays the inputs and checks the invariants "Plain data" and "Exact replay". It also holds `scripted(script)`, a stand-in Client for testing the Runtime. Production code may not import it.
