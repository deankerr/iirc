# @iirc/client

The Client: iirc's pure understanding of one Network. It does no I/O and reads no clock. Every input carries its time, and every effect leaves as an output, so the same inputs always give the same states and outputs.

The Client is `client`, exported from `@iirc/client`.

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

`State` is opaque plain data, rebuilt by replaying the Journal.

### What the caller must do

- Journal each input before stepping it. Step inputs one at a time, in Journal order.
- Journal each step's outputs with its input, then carry them out in order.
- On restart, fold the Journal from `initial`, folding the timer table with `timers` as it goes, then set those timers and step a `Started`.
- Send `Configured` first. Until then, every other input but a `Look`, a `Stopping`, or a `Removed` is ignored.

## Inputs

Each input carries `at`, the instant it happened as the Runtime saw it.

| Input | From | Meaning |
| --- | --- | --- |
| `Started` | Runtime | The Runtime has started. A Connection the Client believed open is over. |
| `Configured` | Owner | The Network's whole Configuration. Joining, parting, and quitting are changes to it. |
| `Say` | Owner | Say something to a Target, with an intent id, and optionally the id of the Message it `answers`. |
| `Act` | Owner | Act on the Network, with an intent id. The actions are under "Acting". |
| `Look` | Owner | Look something up, with an intent id: `Whois`, `Whowas`, `Bans`, `Exceptions`, `Invitations`, `Names`, `Who`, or `Channels`. |
| `Retry` | Owner | Try connecting now, cutting a wait short. |
| `Removed` | Owner | The Owner removed the Network, keeping its Timelines readable or not, as `keep` says. |
| `Read` | Owner | The Owner has read a Timeline up to an instant: a Target's, the Network's own, or one already resolved, by its kind, key, and name as a projection holds it. |
| `CloseTimeline` | Owner | The Owner closed a Timeline, named as a `Read` names one: a Channel Self is not in, or a Direct Message partner's. |
| `Opened`, `Received`, `Closed` | Transport | A Connection opened, one Line's bytes arrived, or a Connection is over, and how. |
| `Fired` | Clock | A timer the Client set is due. It consumes the timer. |
| `Unfilled` | Runtime | A `SendSecret` could not be filled, so nothing was sent. `Unanswerable` is an Ircd's SASL challenge the Runtime would not answer. |
| `ScramChecked` | Runtime | The Runtime checked a `CheckScram`'s server-final message: `verified`, or not. |
| `Unsent` | Runtime | Lines that never left, because their Connection ended or its hang-up ran out of time. |
| `Stopping` | Runtime | The Runtime is shutting down. |

### Configuration

`NetworkConfiguration` is the Schema of what `Configured` carries. It is also exported alone from `@iirc/client/configuration`, as pure data a Frontend may import.

- **A Frontend derives every option from the Schema alone.** Each field has a description and its default, and each Credential field is marked as one.
- **`credentialsOf(configuration)`** gives the names of the Credentials a Configuration names: its Ircd password, its login's, its client certificate's, its operator login's, and each Channel's key.
- **`tls` says whether to present a client certificate,** `none` or `certificate` with the Credential holding it. An `Output.Dial` names that Credential as `certificate` when the address dialled is TLS, an STS upgrade included, and names none for a plaintext one. A `Configured` written before `tls` existed decodes as `none`.
- **A `Sasl` login's `mechanism` is `auto`, `plain`, or `scram-sha-256`.** `auto` uses `SCRAM-SHA-256` where the cap lists it and `PLAIN` otherwise, and the others pin one. A new Network starts with `auto`, and a `Configured` written before it existed decodes as `plain`.
- **An `External` login needs `tls` to be `certificate`.** A Configuration with one and no certificate does not decode.
- **`userModes` and `lines` are sent as each Session begins,** after the welcome and any service login and before any Channel is joined: `userModes` as one `MODE` on Self, then each Line in order, with no intent.
- **Each of `lines` is parsed by the rule `/quote` applies,** in `src/quoted.ts`. One that `/quote` would refuse at that moment is `Ignored` as `Unsendable`.
- **A field added later decodes old Journals as the Client behaved before it,** so an old Journal replays as it happened. `answerCtcp` and `whoOnJoin` start on and decode as off. `bot` starts and decodes as off.

### When the Client dials

- **A `Configured` or `Started` with the Network enabled dials at once.** There is no backoff before a first dial.
- **After a `Closed` it waits on the backoff,** then dials the next Ircd in `ircds`, round and round. `Retry` cuts the wait short.
- **Disabling the Network sends `QUIT`,** hangs up, and waits for the `Closed`.
- **A `Removed` does the same and dials nothing again.** Each Lookup still waiting reports what it has in the removal's own step.
- **A `Stopping` does the same,** and then nothing is dialled and every `Say`, `Act`, and `Look` is refused until the next `Started`.
- **While an STS policy holds for a host, the dial is TLS on the policy's port,** whatever Configuration says.

## Outputs

| Output | Meaning |
| --- | --- |
| `Dial` | Open a Connection to an Ircd, numbered by the Client from 1, never reused. |
| `Send` | Send an `OutboundLine`. It counts as sent unless an `Unsent` says otherwise. Every Line of a `Say` or an `Act` carries its intent, and a CTCP answer the request it `answers`. |
| `SendSecret` | Send a `SecretLine`. The Runtime fills in the Credential with `fillSecret` from `@iirc/protocol`, or answers a `SCRAM-SHA-256` round from its exchange for the Connection. |
| `CheckScram` | Check the Ircd's `SCRAM-SHA-256` server-final message against the Runtime's exchange, which steps the result as `ScramChecked` at once. |
| `Hangup` | End a Connection. The Client still waits for its `Closed`. |
| `Wake` | Set a one-shot timer to an instant, or cancel it with `null`. The same id replaces the earlier one. |

The State holds no timer table. `timers(table, input, outputs)` folds one step of it, for the Runtime to use while replaying.

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

News is what happened in one step, in order. Replaying the Journal makes it again, and it is never journaled.

| News | Meaning |
| --- | --- |
| `Message` | Something said, with its time, id, whether it is `live`, a `highlight`, Self's, or said as a `bot`, the `prefix` its sender held in the Channel, the `nicks` its text names, the masks its sender matched as `ignored`, and `where` it belongs. One we said carries `ours`: its intent, and whether the Ircd will echo it. It `answers` the id a `+reply` tag names, or the one Self's `Say` answered, and a Direct Message carries the Channel a `+channel-context` tag names as its `context`. |
| `Confirmed` | The Ircd echoed back the Message for an intent, with its own time, id, and final text, and the `nicks` that text names. |
| `Activity` | Something that changed, with its time, id, whether it is `live`, the masks the User behind it matched as `ignored`, and `where` it belongs. |
| `SessionBegan`, `SessionEnded` | A Session's start and end, and why it ended. |
| `ConnectionFailed` | A Connection that ended before registration: why, the Ircd dialled, and whether it had opened. |
| `Refolded` | An Ircd declared another casemapping, so keys in `where` fold by it from here on. |
| `NetworkRemoved` | The Owner removed the Network, and `keep` is whether its Timelines stay readable. |
| `ReadMarker` | The Owner's Read Marker of a Timeline moved forward. |
| `TimelineClosed` | The Owner closed a Timeline, keyed as `where` keys it. The Client keeps nothing of it. |
| `Unignored` | The Owner took masks out of the Configuration's `ignores`, each given as every casemapping folds it. |
| `ChannelLearned` | What is known of a Channel Self is in changed with no Activity saying so: its modes or topic, the end of a `NAMES` listing or of a `WHO` answer that described its members, a member's bot mark, a fact of a member a `WHOIS` changed, or a fact of a member gone stale as the Feature that kept it turned off. It names the Channel, keyed as `where` keys it. |
| `PartnerLearned` | Whether a Direct Message partner is on the Network changed with no Activity saying so: the first status `MONITOR` or `WATCH` gave, their joining or leaving a Channel Self shares, or the Session ending. It names the partner, keyed as `where` keys their Timeline. |
| `Refused` | A `Say` or an `Act` that was not carried out: `Offline`, `Unsendable`, `AccountUnknown` or `NoAccount` for a ban by account, `Rejected` by the Ircd with its numeric or code, or `Unsent`. |
| `LookedUp` | A Lookup is over, with its result. Exactly one comes for each `Look`. |
| `Ignored` | An input that changed nothing, and why. |

- **Our own Messages are News when we send them.** With `ours.echo`, a `Confirmed` follows when the Ircd echoes it, and the echo is not a second Message. If its Line never left, a `Refused` `Unsent` follows.
- **History arrives late,** with `live` false, and a Message may come live and again from history under the same id.
- **A Message in a Channel carries its sender's `prefix`,** the symbol of the highest prefix they held there as the Line was folded, by the order of `PREFIX`, and none for a Direct Message, a sender who is no member, or one who holds none. Self's own, said by a `Say`, carries it too. It is fixed when said: a later `MODE` leaves it as it was.
- **A Message carries the `nicks` its text names,** spans of UTF-16 offsets into its text with formatting stripped, in order and never overlapping, each a whole word, by a Highlight's word rule, that is the nick of a User who counts, compared by the Network's casemapping. In a Channel Self is in, those who count are its members as known as the Line was folded, a `NAMES` listing still arriving included, and Self, whoever said it, the Ircd included. In a Direct Message they are the partner and Self, and in the Network's own Timeline, or to a Channel Self is not in, none. A list of Targets counts the union. A nick that holds a character which ends a word is never found. Self's own Messages carry them, and so does a `Confirmed`, for the Ircd's text and the Target it was said to. They are fixed when said, and a Message from history is read the same way.
- **A Message is `self` when Self said it,** from here or from another IRC client, and is never a `highlight`.

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
- **`Joined`, `Parted`, `Kicked`, `TopicChanged`, and a Channel's `ModeChanged`** belong to their Channel. A `Netsplit` or `Netjoin` belongs to the one Channel it tells of.
- **`Invited`, `OperGranted`, `OperRefused`, `Numeric`, `Motd`, and a `ModeChanged` of a User** belong to the Network's own.
- **A `UserInvited`** belongs to its Channel while Self is in it, and otherwise to the Network.
- **Another User's `Quit`, `NickChanged`, `AccountChanged`, `HostChanged`, or `RealnameChanged`** belongs to every Channel they shared with Self, and to their Direct Messages if those exist.
- **Another User's `AwayChanged`, `CameOnline`, and `WentOffline`** belong to their Direct Messages alone, if those exist.
- **A live rename moves the Direct Message Timeline.** One from history renames nothing.
- **Self's `NickChanged`, `Quit`, `AwayChanged`, `AccountChanged`, `HostChanged`, and `RealnameChanged`** belong to the Network, the first two to every Channel Self is in as well.
- **A list of Targets is never one Timeline.** Each item is placed by itself, and a `Say` to a list is `Unsendable`.
- **History is placed as the present is,** by what is known as it arrives.
- **Keys fold by the casemapping the Network last declared,** on any Connection, and `rfc1459` until one has, so a Timeline keeps its key across Connections. When an Ircd declares another, a `Refolded` comes before any News keyed by it.
- **A `Refused` for an `Act` carries `action`:** the action's kind and the names the Owner gave it, never a topic, reason, away message, or mode parameter, so a Channel key given with `+k` never appears. It belongs to the Channel the action was about when the Client held that Channel, and otherwise to the Network's own. An action too old for the Client to remember carries none.

## Knowledge

`known(state)` gives Channels, members, Users, Self, the open Direct Message partners, and where the Session is.

- **Keys fold by the Connection's casemapping,** which starts from `rfc1459` on each Connection. `declared` gives the mapping `where` folds by, and `chantypes` the Session's `CHANTYPES`, so a Frontend compares and prefixes Channels' names as the Network does.
- **Users are Self and those who share a Channel with Self,** and, while a Feature keeps them, those `MONITOR` or `WATCH` says are online. What was seen of a User is forgotten once they are neither.
- **`partners` are the open Direct Message partners,** keyed as `where` keys their Timelines, with whether each is `here`: true while they share a Channel with Self or `MONITOR` or `WATCH` says they are online, false while it says they are offline, and unknown otherwise.
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

A fact's source is `ircd`, `replied`, `receipt`, or `ours`. Nothing in Knowledge names a cap or a Feature, so a new Feature changes which case a fact lands in and not a View's code.

`channel(state, name)` gives one Channel: its members as Users, the prefix modes Self holds, the casemapping, the Network's `PREFIX`, `CHANMODES`, and `CHANTYPES`, with the protocol's defaults until an Ircd says, the modes of its lists of masks, and how a ban names an account. It costs what the Channel holds, where `known` builds every Channel and User. A View that finds a Channel from its Timeline passes the Timeline's name, not its key, since the two may fold by different mappings early in a Connection.

## Inspection

`inspect(state)` gives what Views do not need: each machine's state, the Connection, the caps offered and enabled, ISUPPORT, the STS policies by host, the Features on, and the timer table. A machine that is not running is left out.

| Machine | States |
| --- | --- |
| `network` | `Unconfigured`, `Idle`, `Waiting`, `Connection.Dialing`, `Connection.Open`, `Connection.Closing` |
| `caps` | `Listing`, `Requesting`, `Holding`, `Ready.Steady`, `Ready.Changing`, `None` |
| `presence` | `Registering`, `Session` |
| `keepalive` | `Listening`, `Pinged` |
| `modes` | `Asking` |
| `who` | `Asking` |
| `channel <name>` | `Wanted`, `Joining`, `Joined.Syncing`, `Joined.Synced`, `Refused`, `Kicked` |

## Invariants

- **Pure.** `step` reads no clock, randomness, locale, or time zone, and does no I/O.
- **Plain data.** State holds only strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`.
- **Total.** `step` never throws, for any input in any state.
- **Exact replay.** Folding the Journal's inputs from `initial` gives the same states, outputs, and News.
- **Time comes from inputs.** Every `Wake` instant is computed from an input's `at`. A `Fired` from an earlier setting of a timer is stale and ignored.
- **Hardened, not tuned.** The Client accepts anything the protocol allows, from any Ircd. What it cannot read is `Ignored`, never fatal.
- **Decisions come from structure.** Commands, numerics, tags, and parameters decide. An Ircd's free text never does.
- **One Connection at a time.** Once the Client has begun to hang up, it sends nothing more on that Connection.
- **Credentials appear only by name.** No input or output holds a Credential's value.
- **Never insecure under STS.** Once an Ircd has given a policy over TLS, the Client dials that host only over TLS until the policy expires, and never falls back to plaintext.
- **A required login is never skipped.** A Session begins only if the Configuration does not require a login, or a `903` arrived on this Connection, whatever the Features do.
- **History does not change the present.** A Line that is not `live` is reported as News and changes nothing that is known now.
- **A step costs what its Line touches,** never every member of the Network, so a Message costs the same in a Channel of ten as in one of 10,000 (`scale.test.ts`).
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
| A `Read` or a `CloseTimeline` whose Target names no one Timeline, or a `CloseTimeline` of the Network's own | `Ignored` with `NoTimeline`. |
| A `CloseTimeline` of a Channel Self is in | `Ignored` with `Joined`, naming the Channel as resolved, without a status prefix. |
| A Line a Feature refuses at egress | A `Say` or an `Act` is `Refused` with `Unsendable`. A Line the Client sends itself is `Ignored` with `Unsendable`. Nothing is sent. |
| A Line the Client sends itself that does not fit, such as `Away` again as a Session begins | `Ignored` with `Unsendable`. |
| An answer spread over more Lines than the Client reads | `Ignored` with `Endless`, and taken as a refusal. |
| An echo of what Self said that nothing ties to what we sent, while `echo-message` is being given up | `Ignored` with `UnmatchedEcho`. |
| A `Say` or an `Act` with no Session, while hanging up, or while stopping | `Refused` with `Offline`. |
| A `Say` or an `Act` the Ircd refused | `Refused` with `Rejected`, and its numeric or code. |
| `Unsent` | A `Say` or an `Act` whose Line is among them is `Refused` with `Unsent`, once. A CTCP answer among them, from any Connection, is a `CtcpUnsent`, where its request is. |
| `Unfilled` | SASL counts it as a failed login, by the round that sent it. A service login's Channels are joined at once. An `OPER` awaits no answer. A Channel whose key is unfilled is refused. Registration goes on without `PASS`. |
| A Feature hook that throws | That Feature is off for the rest of the Connection, and `Ignored` with `FeatureFailed` records it. |

## The Feature seam

A Feature brings one IRCv3 cap or ISUPPORT token, or a tight group of them, to the Client. The seam is internal: Features are tested only through `step`. The seam's stages and hooks are in `src/feature.ts`, the order Features run in is `src/registry.ts`, and `src/features/` holds the Features, of which `multi-prefix` and `server-time` are the shortest to read first.

- **On and off.** A Feature is on while every cap it `needs` is enabled and every token is in ISUPPORT, and its `accepts`, if it has one, says yes to what ISUPPORT holds, unless the Owner declined it.
- **Asking.** A Feature's caps are asked for together, and only when every one is offered.
- **Nothing from history acts.** Only a live Line lets a Feature send a Line or decide registration.
- **Turning off marks stale only the facts that Feature kept,** such as away status without `away-notify`.
- **STS is not a Feature.** The core keeps it, in `src/sts.ts`.

## Features

Each Feature's scenarios play strictly through `step`, in `src/scenarios/`.

### The floor

These need nothing from the Ircd beyond RFC 1459 and 2812.

- **Connecting and redialling** (`connection.test.ts`). The backoff is 2 s doubling to 5 minutes, and starts again after a Session that lasted 5 minutes. It takes no randomness.
- **Registration** (`registration.test.ts`). Sends `CAP LS 302`, `PASS` when configured, `NICK`, and `USER` at once. An Ircd with no cap negotiation answers `421` or goes straight to `001`. When a nick is taken, it offers the configured nicks in order, then the first with `_`, `2`, `3`, and on, within `NICKLEN`.
- **Taking the first nick back** (`reclaim.test.ts`, `monitor.test.ts`, `watch.test.ts`). When Self holds another nick it settled for, it asks once for the first configured nick as soon as it sees that nick's holder leave it, by a `QUIT` or a `NICK` to another nick (not a change of case), or `MONITOR` or `WATCH` reports it offline. A refusal is not retried until the holder is seen to leave again, and nothing polls.
- **Taking back stops for the Session** once the Owner sets a nick, or once the Network renames Self off the first nick with no `NICK` of ours asking. The ask's answer is never taken for an answer to the Owner's own `NICK`, and it is Activity like any other change of Self's nick.
- **The Session and ISUPPORT** (`session.test.ts`). `001` begins a Session. ISUPPORT accumulates over every `005`, at most 256 tokens. Self's mask is never read from `001`.
- **What the Owner sends as a Session begins** (`session-start.test.ts`). The `userModes` and `lines` under "Configuration".
- **A service login** (`service-login.test.ts`, `self-account.test.ts`). With a `Service` login, each Session begins by telling the service `IDENTIFY <account> <credential>` in a `PRIVMSG`, and its Channels wait. A `900`, or with `account-notify` an `ACCOUNT` for Self that names an account, also makes Self's account known and lets them be joined, as do the Configuration's `wait` running out, an unfilled Credential, and a Configuration with no service login. No user mode and no `NOTICE` from the service counts.
- **A service login never tells its Credential while the Ircd may echo it.** It stops `echo-message` being asked for on later Connections, and a Session that finds it on or asked for at `001` tells nothing and joins at once. A Connection that has `echo-message` keeps the Feature on, so each echo is still matched to its Message.
- **What an Ircd says** (`numerics.test.ts`). A live numeric that nothing else reports, such as the welcome, the counts of Users, or a `422`, is a `Numeric` Activity in the Network's own Timeline, by its number and its parameters after the one that names Self, as they came. One collected for a Lookup, tied to an action, or answering a Line the Client sent itself is not shown, nor is one the Client reads otherwise, which `unshown` in `src/lines.ts` lists.
- **The message of the day** (`motd.test.ts`). The `372` Lines between a `375` and a `376` are one `Motd` Activity in the Network's own Timeline, each line as it came, shown when the `376` comes. It is bounded at 200 lines: past that it shows `cut`, and the rest is dropped until its `376`. The next `375`, or the Connection ending, before its `376` shows it `cut` with what it has. A `372` or `376` outside one shows as any numeric does.
- **An operator login** (`oper.test.ts`). With an `oper` login, each Session begins by sending `OPER <name> <credential>` and awaits the answer, read from its numeric alone: `381` is an `OperGranted`, and `464`, `491`, or a `461` naming `OPER` an `OperRefused`, each once, in the Network's own Timeline. A numeric when nothing awaits it is shown as it came.
- **Keepalive** (`keepalive.test.ts`). Answers `PING` at once, byte for byte. After 60 s of silence it sends a `PING`, and after 90 s it hangs up.
- **A Channel's modes** (`modes.test.ts`). Each time Self's join is confirmed, the Client asks the Channel's modes once with `MODE <channel>` and folds the `324` that answers. One query waits at a time on a Connection, each when the last is answered or after 30 s, so the Owner's Lines never queue behind them all. A Channel whose modes are already known by its turn is not asked.
- **Modes stay true or unknown.** An error in answer leaves them unknown. A `MODE` while they are known keeps them true, by `CHANMODES`, with `PREFIX`'s modes as membership, and one while they are unknown leaves them unknown, never a partial set. A key is kept only as set.
- **Who is in a Channel** (`who.test.ts`). With the Configuration's `whoOnJoin`, once the `NAMES` listing that follows Self's join ends, the Client asks `WHO <channel>` once a Session, one Channel at a time as for `MODE` and independently of it. With `WHOX` it asks `%tcuhnfar` with a token of its own and reads only a `354` that carries it, an account of `0` meaning logged out. Without it, a `352` gives the mask, realname, and away status, and no account.
- **A `WHO` answer refreshes only members the Client keeps,** never Self. `G` is away and `H` here, the mode `BOT` names among the flags marks a bot, and an away member keeps the away message already known, or none.
- **The `WHO` on joining ends** with its `315`, a `421` or `461` naming `WHO`, a `FAIL` of `WHO`, or an `Unsent` of it, and takes no error numeric naming its Channel. After 30 s the next Channel is asked, and the late answer is still read until its `315`. It reports no Activity, only a `ChannelLearned` when an answer that described anyone ends.
- **Channels** (`channels.test.ts`). Each Channel the Owner wants is a machine. Wanted Channels share `JOIN` Lines as `TARGMAX` allows, and one with a key goes alone. A Channel the Ircd refused, a kick, or a `PART` the Owner did not ask for is joined again on the backoff. One whose name cannot be sent, or whose key is unfilled, waits for the next Session or a change of Configuration. A Channel Self was put in without asking is followed with `wanted` false and never joined again. Without `multi-prefix`, a member's prefixes are partial.
- **Messages and Activity** (`messages.test.ts`, `where.test.ts`). `PRIVMSG` and `NOTICE` are Messages, and a CTCP `ACTION` an action. A `DCC` is dropped, and other CTCP is Activity. `JOIN`, `PART`, `QUIT`, `NICK`, `KICK`, `TOPIC`, `MODE`, and `AWAY` are Activity, and so is a standard reply that refused nothing. A `Say` that the Ircd would cut short relaying it is `Unsendable`, never truncated.
- **Invitations** (`invite.test.ts`). An `INVITE` that names Self is an `Invited`, by who invited and to which Channel, in the Network's own Timeline. One that names another User is not reported, unless `invite-notify` is on.
- **CTCP requests** (`ctcp.test.ts`). A CTCP in a `PRIVMSG` from another User is a `CtcpRequest`, with what became of it, and one in a `NOTICE` a `CtcpReply`. Each belongs to every Channel it was sent to, and otherwise to the Network, and to the sender's Direct Messages if those exist.
- **CTCP answers.** Self answers a live `VERSION` (`iirc`, and nothing of what it runs), `PING` (its arguments, back), `TIME` (when the request arrived, in UTC), and `CLIENTINFO` with a `NOTICE` to the sender's nick, never to a Channel or a mask, and answers nothing when `answerCtcp` is off. Answers take a budget of three at once and then one every ten seconds, which reconnecting does not refill. A request that is not answered says why, and none is dropped.
- **A CTCP reply carries `roundTrip`** when it is live, to Self, from the User a `PING` the Owner sent went to, with that `PING`'s token: the milliseconds between the instants the Runtime journaled the request and the reply. Every other reply carries `null`. The User is followed through a change of nick, and the `PING` is forgotten when they quit or another User takes the nick.
- **An answer that never left is a `CtcpUnsent`,** in the Timelines its request is in as they stand then. Once another User took that nick, or 64 later answers have pushed it out of memory, it goes to the Network's own Timeline alone. Its budget stays spent.
- **Read Markers** (`read.test.ts`). A `Read` moves one Timeline's Read Marker forward, never back, so two Frontends marking at once cannot undo each other. It needs no Session, and markers outlive Connections.
- **Closing a Timeline** (`close.test.ts`). A `CloseTimeline` names a Channel or a Direct Message partner as a `Read` does, never the Network's own, and is reported unless Self is in that Channel now. It needs no Session.
- **A Timeline already resolved** (`resolved.test.ts`). A `Read` or a `CloseTimeline` may name a Timeline by its kind, key, and name, as a projection holds it, instead of a Target. It is taken as it is, with nothing parsed or folded, so a Channel only `CHANTYPES` made one is named while the Network is offline, and it shares the Read Marker its Target has.
- **Highlights** (`highlight.test.ts`). A live Message from another User is a Highlight when it holds Self's nick, or one of the Configuration's `highlights`, as a whole word. Word boundaries use Unicode 17.0, pinned in `src/word-characters.ts`, so a Journal gives the same Highlights on every runtime. The search is linear in the text, however hostile.
- **Ignoring by mask** (`ignore.test.ts`). The Configuration's `ignores` are `nick!user@host` masks, at most 64, and a mask respelt in another case is the same mask. A Message or an Activity from a User one of them matches, by its source, carries those masks as `ignored`, folded by the casemapping the Network last declared, each once, in the Configuration's order.
- **The ignored User is the one who acted:** who joined, quit, set a mode, or kicked, not the one kicked. A `HostChanged` is stamped by the mask the User had or the one they have now. History is stamped as live is, and a Message from a server never is, nor is Self.
- **The Client drops nothing for an ignore.** A projection hides what is stamped, and shows it again on `Unignored`, which gives each mask no longer held as every casemapping folds it, less any fold a mask still held shares. An ignored User's Direct Message opens no partner to monitor, and a CTCP request from them is stamped and still answered.
- **What is ignored** (`ignored.test.ts`). Nothing unreadable ends the Connection.
- **Stopping** (`stopping.test.ts`). A `Stopping` and an `Unsent` behave as "When the Client dials" and "Error modes" say.
- **Hostile input** (`properties.test.ts`, `regressions.test.ts`). Random and hostile Lines keep every invariant, step after step.

### Acting

`acts.test.ts`. An `Act` sends what the Owner asks, built only through `@iirc/protocol`'s builders and checked first against what the Client knows of the Network. A Line that cannot be sent whole is `Unsendable`, never cut short.

- **`Topic`, `Kick`, and `Nick`** are checked against `TOPICLEN`, `KICKLEN`, and `NICKLEN`, and a `Kick` of many nicks against `TARGMAX`. An `Invite` needs a Channel's name and a nick.
- **`Setname`** (`masks.test.ts`) changes Self's realname with `SETNAME` while `setname` is enabled. It is `Unsendable` otherwise, when the realname is empty or longer than `NAMELEN`, or when the Line does not fit as the Ircd relays it. The Ircd's `SETNAME` back, or a `FAIL` of it, answers it.
- **`Mode`** gives each change a parameter exactly as `PREFIX` and `CHANMODES` say, and splits across Lines by `MODES`. A mode neither names is `Unsendable`.
- **`BanAccount`** (`ban-account.test.ts`) bans a User from a Channel by the account the Client knows, as `MODE <channel> +b <mask>`, where `EXTBAN` and `ACCOUNTEXTBAN` say how a ban names an account and `CHANMODES` lists `b`. It is reported as a `Mode` of `+b` on its Channel, and a Channel's view says `accountExtban` for a Frontend to offer it.
- **`BanAccount` never falls back to a mask of a nick.** It is `Unsendable` when either token is missing or malformed or the mask cannot name the account exactly, `AccountUnknown` when nothing known says which account the User holds, and `NoAccount` when they are known to be logged out.
- **`Away`** describes the Owner, so it outlives Sessions and is sent again as each begins. It is the one action that needs no Session, and in one it is checked against `AWAYLEN`.
- **`Ctcp` and `Ping`** (`ctcp.test.ts`) send a CTCP request in a `PRIVMSG` to one User, never a Channel, a `STATUSMSG` Target, a list, or a mask, and are reported as a `CtcpSent` where that User's replies go. `Ctcp` sends its command upper-cased, with its arguments as given, and never `ACTION` or `DCC`.
- **A `Ping`'s token is unique on its Connection:** the instant it was sent, in milliseconds, then a hyphen and how many `PING`s were sent before it. At most 64 are remembered, so a reply tells its round trip.
- **Nothing waits on a CTCP reply.** No timer is set, only a label can tie a refusal to the request, the oldest is forgotten past the bound, and the rest end with the Connection.
- **`Part`** parts one Channel the Configuration does not want, such as one the Ircd put Self in. A Channel the Configuration wants is `Unsendable`. Self's own `PART` of the Channel answers it.
- **`Raw`** sends a Line written as text. It may not be `CAP`, `PASS`, `AUTHENTICATE`, or `OPER`, nor a `JOIN` or `PART` of a Channel the Configuration wants. The Client follows whatever the Ircd echoes back, as if another IRC client of the same account had sent it.
- **A refusal is tied to its action by structure.** With `labeled-response`, by label. On the floor, an error numeric is tied to the oldest Line of an action that names what the numeric names, such as `482` by its Channel.
- **The Client's own `MODE` query waits among the actions** (`modes.test.ts`) in the order it was sent, and takes a `324` of its Channel, an error numeric naming its Channel, or a `421` or `461` naming `MODE`, when it is the oldest.
- **Some refusals cannot be tied on the floor:** a numeric that names nothing the action named, and anything an Ircd says only in text. A `472` names a mode, so it ties to the oldest `MODE` that changes that mode, or a list Lookup asked by it, whichever was sent first (`mask-lists.test.ts`).

### Lookups

`lookups.test.ts`, `mask-lists.test.ts`, `names-who.test.ts`, and `list.test.ts`. A `Look` asks the Network something and collects the reply, which may span many Lines, into one `LookedUp`.

- **Every `Look` gets exactly one result:** `Found` or `Partial` with the Users a `WHOIS` or `WHOWAS` described, `Listed` with a Channel's masks, `Members` from a `NAMES`, `Users` from a `WHO`, or `Channels` from a `LIST`, each of the last four with why it was cut short, if it was, or `NotFound`, `Failed`, `Refused`, or `Unsent`.
- **A `NAMES` takes a Channel's name by the Network's rules, and a `WHO` one mask,** asking no WHOX fields.
- **A `NAMES` corrects a Channel's members only when its `366` comes.** It collects into a listing of its own, then replaces the members of a Channel Self is in, even past the bound of what it reports. One whose time runs out reports what it has and reads on until its `366` or its labelled answer's end. One over without its `366` corrects nothing.
- **A labelled `NAMES` or `WHO` that ends without its `366` or `315`** is cut short as `Ended`.
- **A Channel's list is asked by the mode ISUPPORT gives it.** Bans are `b` while `CHANMODES` lists it. Exceptions and invitation masks are the modes `EXCEPTS` and `INVEX` name, `e` and `I` when they name none, offered only when the token is sent and `CHANMODES` lists the mode as a list. One the Network does not offer is `Refused` as `NotOffered`, and nothing is sent. Each mask keeps who set it and when, where the Ircd says.
- **A `LIST` asks only what the Ircd's `ELIST` offers,** as one parameter: the mask by `M`, unless it starts with `!`, which an Ircd with `N` reads as its negation, and the least members by `U`, as `>N` for one fewer. The Client filters by what the Ircd is not asked itself, the mask as a glob of `*` and `?` folded by the Network's casemapping. A mask that is empty or holds a comma or a space is `Unsendable`.
- **A `LIST` keeps the 1000 Channels with the most members,** most first, then by name. Each `322` that names a Channel by the Network's rules with a count of digits is seen, and any other is `Malformed` and skipped. Its result says how many it saw, and is `Bounded` only when that is more than it kept.
- **One `LIST` at a time, tied by structure alone and never labelled.** A second `LIST` while one awaits is `Refused` as `Busy`, and nothing is sent. Its `321`, `322`, and `323` are never part of another Lookup's reply.
- **A `LIST` ends at once,** before its rows begin, on a `263` or `421` naming `LIST` or a `FAIL` of `LIST`. Once a `321` or `322` has come, only its `323` or its Connection's end does, and a later `FAIL` is kept in its notes. One whose time runs out reports what it has and reads on, keeping nothing, still holding off another.
- **A reply is collected by structure.** With `labeled-response`, by its label. On the floor, a numeric belongs to the oldest Lookup whose nick, Channel, or mask it names, or to an action or the Client's own `MODE` query sent before it that it names.
- **A `421` or `461`, and a standard reply, name a command instead,** and go to whichever sent with that command was sent first. A `352` goes to the oldest `WHO` Lookup, but one naming a Channel whose `WHO` on joining is still answered goes to that answer alone, unless the Lookup asked that Channel.
- **Only reply numerics and standard replies are read.** A numeric the Client does not model is kept as it came. A `FAIL` ends the Lookup by its code, at once when it was sent without a label, and so does an error numeric that refuses a list, a `NAMES`, or a `WHO`. A `WARN` or `NOTE`, and each `FAIL` after the first, is kept in the result's `notes`.
- **Nothing is read from free text but the one mode word of a `379`.** A `335` says the User is a bot only where the Ircd names a bot mode, and only as `335 <client> <nick> :<text>`. One of another shape, or where the Ircd names none, is kept as it came.
- **Bounded.** At most 8 Lookups await their replies on a Connection, at most 64 Lines of one are kept, besides at most 500 members or Users, or 1000 Channels, and one with no end within 30 s reports what it has.
- **A `WHOIS` refreshes only what the Client already models,** and never undoes something said since. When that changes how a fact of a User is known or its value, each Joined Channel the User is in is reported `ChannelLearned` once, every one for Self. The Client never sends a Lookup itself, so nothing is polled.

### Standard replies

`standard-replies.test.ts`. `FAIL`, `WARN`, and `NOTE` are read by structure: the command they are about, their code, their context, and their description, each its own field. Nothing is decided from the description.

- **One that answers something Self sent is shown with it.** By label where there is one: where the `Say`'s Message stands, where the action belongs, or on the Lookup's result. On the floor, by the command it names, to the oldest Line of an action or Lookup sent with that command.
- **One that names `PRIVMSG` or `NOTICE` on the floor is a guess.** It goes to the Target of the latest unlabelled `Say` of that command on the Connection. That Target follows its partner's change of nick, and is forgotten when the Connection ends or another partner takes the nick, when the reply falls to the Network's own Timeline.
- **A `FAIL` refuses.** One that answers an intent by label, or an action by its command, refuses it with its code, as an error numeric does. An intent is refused once: each later `FAIL` for it, and one tied to a `Say` by the guess, is shown where it belongs. A `WARN` or `NOTE` settles nothing.
- **The rest are Activity in the Network's own Timeline,** a `FAIL` that refused nothing and every one from history included. None is dropped.

### With caps

| Feature | Needs | Changes | Scenarios |
| --- | --- | --- | --- |
| Cap negotiation | caps from the Ircd | Asks for each Feature's caps, whole or not at all. Only what the Ircd acknowledges is enabled. `CAP NEW` and `CAP DEL` are followed for the rest of the Connection. | `caps.test.ts` |
| Cap notify | `cap-notify` | Asks for the cap, so an Ircd that keeps to the rules before 302 sends `CAP NEW` and `CAP DEL`. | `caps.test.ts` |
| SASL | `sasl`, and a SASL login in the Configuration | Logs in with `SCRAM-SHA-256` or `PLAIN` for a `Sasl` login, as its `mechanism` says, or `EXTERNAL`, by the client certificate, for an `External` one, holding registration until `903`. A mechanism the cap's value lists without it is not tried, nor is `SCRAM-SHA-256` where the cap lists nothing. `SCRAM-SHA-256` asks the Runtime for each answer as a `SendSecret` naming the Credential and carrying what the Ircd sent, reads a message split over full `AUTHENTICATE` Lines whole, and has the server-final message checked with `CheckScram`. The State holds only which round it is in, never a nonce, a salt, or a proof. Only a verified server and then `903` is a login, and a failed one never tries `PLAIN`. A failed login goes on when it is optional, and gives up the Connection with `LoginFailed` when it is required. A `CAP NEW` that offers `sasl` during a Session with no account known for Self logs in the same way, holding nothing, and a failure there ends nothing: its numeric is shown in the Network's Timeline. | `sasl.test.ts`, `scram.test.ts`, `login.test.ts` |
| Message tags | `message-tags` | A Line's `msgid` is its Message's id. Client-only tags are reported with the Message, and `+reply` and `+channel-context` are read, ignored where their specs say. A `Say` that `answers` a Message carries `+reply` where the Session has `message-tags`, and is still said without it. Knowledge says which, as `tags`. | `tags.test.ts`, `replies.test.ts` |
| Server time | `server-time` | A Line's `time` tag is when it happened. Without it, or when malformed, the time is when the Line arrived. | `tags.test.ts` |
| Batches | `batch` | Tracks open batches, nested or interleaved. Lines are read as they arrive, never held back. A split holds only its News. | `batch.test.ts` |
| Splits | `batch` | A live `netsplit` or `netjoin` batch, opened outside any other and naming exactly two servers, is one `Netsplit` or `Netjoin` Activity in each Channel its quits or joins touched, shown at its `BATCH -`, with the servers and the members' nicks. Its Lines change what is known as they arrive, and each quit is still shown alone in a Direct Message Timeline that exists. At most 64 are read at once, one from history is read unbatched, and together they hold at most 4096 quits or joins across the Connection. One that cannot be read as a split gives back what it held, as it was, and the rest of it is read unbatched. | `netsplit.test.ts` |
| Echoes | `echo-message`, `labeled-response`, and `batch`, only together | Each `Say` is labelled, and its echo is `Confirmed`. An error in its answer is `Rejected`, and a `WARN` or `NOTE` in it is shown where the Message stands. | `echo.test.ts` |
| Standard replies | `standard-replies` | Asks for the cap. `FAIL`, `WARN`, and `NOTE` are read whether or not it was asked for. | `caps.test.ts`, `standard-replies.test.ts` |
| Member prefixes | `multi-prefix` | A `NAMES` listing shows every prefix, so a member's prefixes are known, not partial. | `prefixes.test.ts` |
| Away status | `away-notify` | Away status is kept up to date, and goes stale when the cap is deleted. | `away.test.ts` |
| Account tags | `account-tag` | A User's Message or Activity without an `account` tag says they are logged out, and with one, their account. A tag with no value says nothing. | `accounts.test.ts` |
| Account changes | `account-notify` | An `ACCOUNT` Line is `AccountChanged` Activity, `*` meaning logged out. One for Self that names an account ends a service login's wait, as a `900` does. Accounts, Self's too, go stale when the cap is deleted. | `accounts.test.ts`, `self-account.test.ts` |
| Extended joins | `extended-join` | A `JOIN` with an account and a realname sets both, `*` meaning logged out. | `accounts.test.ts` |
| Host changes | `chghost` | A `CHGHOST` Line is `HostChanged` Activity, with no quit or join, and changes the User's mask, or Self's. One that is not from a User's whole mask with exactly two parameters that make a mask is `Malformed`. Masks go stale when the cap is deleted. | `masks.test.ts` |
| Masks in names | `userhost-in-names` | A name in a `NAMES` listing may be `<prefixes>nick!user@host`, and the member's mask is known at once. A name with a `!` or an `@` that does not split into a nick, user, and host adds no member. | `masks.test.ts` |
| Realname changes | `setname` | A `SETNAME` Line is `RealnameChanged` Activity and changes the User's realname, or Self's. One not from a User's whole mask, or without exactly one non-empty realname, is `Malformed`. Realnames go stale when the cap is deleted. The Owner's `Setname` needs it. | `masks.test.ts` |
| Invitations of others | `invite-notify` | An `INVITE` naming another User is `UserInvited` Activity, by who invited whom. One not from a User's whole mask with a nick for its nick, or without exactly a nick and a Channel's name, is `Malformed`. | `invite.test.ts` |
| Extended monitor | `extended-monitor` | A User `MONITOR` says is online is kept as one in a shared Channel is, so `AWAY` and `ACCOUNT` keep their facts and `730` their mask. They go stale when the cap is deleted. | `monitor.test.ts` |
| Bot mode | the ISUPPORT token `BOT`, as exactly one letter | A User's Message or Activity with a `bot` tag, of any value, says they are a bot and marks the Message `bot`. While the Session carries tags, one without it says they are not. A `MODE` on Self that sets or unsets the mode says whether Self is one. With the Configuration's `bot`, Self sends `MODE <self> +<mode>` once a Connection, as the token is first known in a Session. Bot marks go stale when the token is taken back, and a `BOT` of anything but one letter turns the Feature off. | `bot-mode.test.ts` |
| UTF-8 only | the ISUPPORT token `UTF8ONLY` | Bytes are read as UTF-8 with no fallback, and nothing leaves that is not UTF-8. | `utf8.test.ts` |

`seam.test.ts` drives each stage of the seam with Features of its own, and `laws.test.ts` runs the four laws over every Feature in the registry.

### Presence, with MONITOR or WATCH

`monitor.test.ts` and `watch.test.ts`. Where ISUPPORT offers `MONITOR`, the Client monitors the Users it cares about. Where it offers only `WATCH`, the same list is kept through that, and a Frontend sees exactly the same. Where it offers both, `MONITOR` is used, and a list `WATCH` kept before a later `005` offered `MONITOR` moves to it whole. Without either, nothing is sent or reported.

- **The list is derived, in order:** the first configured nick while Self would take it back, then each open Direct Message partner, most recently messaged first. It is cut to the command's limit and to 256 partners, less what a `734` or `512` refused on the Connection, which is never sent again there. Self is never on it.
- **The partners are folded from the Client's own News:** a Direct Message adds a partner, a live rename moves them, and closing their Timeline removes them.
- **Only the difference is sent,** removals first, in as few Lines as fit, after a step that may change the list. Each Session sends it whole once its `005` offers the command. Nothing polls.
- **`730` and `731` say who is online,** as `604` and `600`, and `605` and `601`, do for `WATCH`. The first word on a nick after it is added is learned silently. Only a change from what the Connection knew is Activity, `CameOnline` or `WentOffline`, and only for a partner. A `QUIT` or rename seen in a shared Channel is that change already.
- **A refusal ends it for the Connection:** a `421` or `461` naming the command, or a `FAIL` of it. Nothing is retried.

### Strict Transport Security

`sts.test.ts`. The core reads the `sts` cap's value from every `CAP LS` and `CAP NEW`, and never asks for the cap.

- **Learning.** Over TLS, a `duration` stores a policy for the Connection's host, on this Connection's port. `duration=0` removes it.
- **Upgrading.** Over plaintext, a `port` ends the Connection and dials the same host over TLS on that port at once. If that TLS fails, it is never retried in plaintext.
- **Dialling.** While a policy holds for a host, every dial to it is TLS on the policy's port.
- **Hosts.** Policies are keyed by DNS name, and an IP literal never gets one. Only hosts in the Owner's `ircds` can have one.
- **Derived.** Policies come from journaled Lines, so replay rebuilds them across a restart.

### Recorded Ircds

`fixtures.test.ts`. The fixtures in `fixtures/transcripts` are real Sessions on Ergo, ngircd, and hybrid, and replay through the Client with nothing `Ignored`.

## The test kit

`@iirc/client/testing` holds the transcript test kit and `scripted(script)`, a stand-in Client for testing the Runtime. `src/testing/README.md` describes it. Production code may not import it.
