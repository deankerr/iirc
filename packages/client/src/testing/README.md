# The transcript test kit

`@iirc/client/testing` is how a Client is tested: a scenario is a transcript of IRC, and the kit plays it through the Client on a fake clock. It holds the scripted Client too. Production code never imports it, and the lint fence holds it to that. [The design note](../../../../docs/notes/2026-11-08-client-interface.md#the-transcript-test-kit) says why it has this shape, and [the transcript spike](../../../../docs/notes/2026-11-09-transcript-spike.md) says where the format came from.

The kit catches the bugs a Client plausibly has, and does not defend against a Client written to fool it, such as one that hides a Proxy in its State.

```ts
import { configured, joined, play, registered } from "@iirc/client/testing";

const base = configured({ nicks: ["iirc"] });

play(client, {
  configuration: base,
  transcript: [
    registered(base, { offered: ["multi-prefix"] }),
    joined(base, "#iirc", ["@peer"]),
    "<< :peer!u@h PRIVMSG #iirc :hi\n",
    "?? message Privmsg peer #iirc :hi\n",
  ],
});
```

## Items

A transcript is one item per line, and ends with a newline. `print(parse(text))` gives `text` back exactly.

| Item | Example | Meaning |
| --- | --- | --- |
| `<<` | `<< :irc.test 001 iirc :Welcome` | The Ircd sends a Line: a `Received` now, from the current Connection. |
| `>>` | `>> CAP LS 302` | The Client must `Send` exactly these bytes next, as `encode` writes them. |
| `<<\ `, `>>\ ` | `<<\ :irc.test 375 iirc :- MOTD -\x20` | The same, escaped: `\\` and `\xNN`. Used for bytes that are not UTF-8, control bytes such as CTCP's `\x01`, a byte order mark anywhere (written `\xef\xbb\xbf`, never dropped), a trailing space, and a sent Line that starts with `{`. |
| `>> {…}` | `>> {AuthenticatePlain credential=libera authcid=iirc authzid=iirc}` | The Client must `SendSecret` this `SecretLine`. The placeholder is the whole item and names every field but the value, so a strict match checks them all. Values escape a space, `\`, `{`, and `}` as `\xNN`. |
| `-> dial` | `-> dial irc.test:6697 tls` | The Client must `Dial` this Ircd. The nth dial in a transcript is Connection n, from 1. |
| `-> hangup` | `-> hangup` | The Client must `Hangup` the current Connection. |
| `== opened` | `== opened` | The current Connection is open. |
| `== closed` | `== closed Reset` | The current Connection is over, with a `CloseReason`. |
| `== started` | `== started` | The Runtime has started. |
| `== unfilled` | `== unfilled Missing` | The last `>> {…}` written could not be filled, with an `UnfilledReason`. |
| `== fired` | `== fired ping t+30s` | A timer fires now, with the `due` its `Wake` set. Use it to write a stale firing. |
| `== connection` | `== connection 1` | Later Transport inputs come from Connection 1, until the next dial. Use it to write input from an old Connection. |
| `!! configure` | `!! configure +#iirc -#old` | The Owner's Configuration, whole, after these changes to it. With no changes, the scenario's Configuration as it stands. |
| `!! say` | `!! say #iirc :hello` | A `Say`. `notice` and `action` say the other kinds. Intent ids are `i1`, `i2`, … in order. |
| `!! retry` | `!! retry` | A `Retry`. |
| `+Ns` | `+60s`, `+250ms`, `+2m` | The fake clock moves on. Each timer that falls due fires in order, at its own `due`, and its outputs are expected next. |
| `??` | `?? ignored Malformed MODE` | A News of this step, written as `describeNews` writes it. |
| `...` | `...` | Any outputs and News, up to the next expectation. |
| `#` | `# peer >> JOIN #iirc` | A comment. |
| blank |  | Separates parts for a reader. |

The changes `!! configure` takes, separated by one space:

| Change | Meaning |
| --- | --- |
| `+#iirc` | Want a Channel. |
| `+#secret key=chankey` | Want a Channel, with its key named as a Credential. |
| `-#iirc` | Part a Channel. |
| `enable`, `disable` | Turn the Network on or off. |
| `decline=multi-prefix`, `accept=multi-prefix` | Decline a Feature, or stop declining it. |

Instants are written against the clock, which starts at the epoch, 2026-01-01T00:00:00.000Z: `t+13s`, `t+1500ms`, `t-5s`.

## News, as `??` writes it

A `??` matches a News when its text is exactly what `describeNews(news, at)` writes, with `at` the time of the input that made it. Defaults are left out, so the common case is short: a time known by `receipt` at the input's time, an unknown id, live, no client-only tags, and not ours.

| News | Example |
| --- | --- |
| `Ignored` | `?? ignored Unparseable Empty`, `?? ignored StaleConnection 1`, `?? ignored StaleTimer ping`, `?? ignored NotNow Opened`, `?? ignored FeatureFailed sasl`, `?? ignored Unsendable PONG`, `?? ignored UnmatchedEcho` |
| `Refused` | `?? refused i1 Offline`, `?? refused i2 Rejected 404` |
| `SessionBegan` | `?? session-began iirc`, or `… at=t+5s` when not now |
| `SessionEnded` | `?? session-ended Closed Ended`, `?? session-ended Upgrading 6697` |
| `ConnectionFailed` | `?? connection-failed Closed Refused` |
| `Message` | `?? message Privmsg peer #iirc id=ircd:m1 at=ircd:t+1s history tags=+draft/reply="m0" ours=i1 echo :hi` |
| `Confirmed` | `?? confirmed i1 id=ircd:m4 at=ircd:t+1s :hello` |
| `Activity` | `?? activity Joined #iirc peer`, `?? activity Kicked #iirc peer by=op :bye`, `?? activity ModeChanged #iirc by=op +o=peer -k`, `?? activity TopicChanged #iirc by=op setBy=op :topic`, `?? activity AwayChanged peer back` |

A fact is `unknown`, `<from>:<value>` when known as of now, with `@<instant>` when known as of another time, `partial:<from>:<value>`, or `stale:<was>@<since>`.

A string from News, such as a nick, a Channel, an id, or a command, is written bare when it holds no space, `"`, `=`, `@`, `:`, or `;`, and otherwise quoted as JSON, so no value can imitate an instant or an attribute: an id `m1` known as of `t+0s` is `id=ircd:m1@t+0s`, and an id `m1@t+0s` is `id=ircd:"m1@t+0s"`. `atom(text)` writes one. The trailing text after ` :` is written as it is, since nothing follows it.

## Playing

| Function | What it does |
| --- | --- |
| `play(client, { configuration, transcript })` | Strict, for hand-written scenarios. Returns what happened: `inputs`, `steps`, the last `state`, the `transcript`, each `ignored`, and the `timers` still set. |
| `replay(client, { configuration, transcript })` | For recorded fixtures. Feeds only `<<`, `==`, `+Ns`, and `!!`, and reports every output and News in its `transcript` and every `Ignored` in `ignored`, without matching `>>` or `->`, which are the recorder's Lines. Unless the first input is an `!! configure`, one is stepped first. |
| `checkReplay(client, played)` | The exact-replay check that `play` and `replay` run, given a `Played`'s `inputs`, `snapshots`, and `steps`. `snapshot(client, step)` writes one step down. |
| `replayFresh(client, inputs, { module, name })` | The same fold in a child `bun` process, compared by a digest of the initial Inspection and Knowledge and every step's state, outputs, News, Inspection, and Knowledge. Async, and slower, so a suite runs it on a few scenarios. |

`transcript` is text, or its parts in order. Each throws on failure: `TranscriptMismatchError`, `ReplayMismatchError`, `FreshReplayMismatchError`, or `ScenarioError` for a transcript the kit cannot play.

The rules of strict play:

- **Outputs.** Every `Send`, `SendSecret`, `Dial`, and `Hangup` must be written, in order, before the next input. A Line on another Connection, or a dial out of order, is a mismatch.
- **Ignored.** Every `Ignored` must be written, and a `??` cannot skip one to reach a later News. Other News need not be written, but a `??` that is written must match a News of its step, in order.
- **`...`** allows anything, `Ignored` included, until the next expectation matches.
- **Timers.** `Wake` is never written. The kit keeps the timer table with the Client's own projection, `timers(table, input, outputs)`, and fires `Fired { at, due, timer }` as the clock passes `due`. Timers are one-shot: a `Fired` whose `due` matches consumes its timer, and it is set again only if that step outputs a fresh `Wake`. `Played.timers` is the table at the end, exactly as the Runtime would rebuild it on restart. The kit never filters a firing: a stale one is the Client's to ignore, as in production, and `== fired` writes one by hand.
- **Diffs.** A mismatch throws a transcript diff, `-` for the scenario and `+` for what the Client did, so a failing test reads as IRC:

```
TranscriptMismatchError: The transcript did not play as written. - is the scenario, + is what the Client did.
@@ line 2 @@
  -> dial irc.test:6697 tls
  == opened
  >> CAP LS 302
- >> NICK other
+ >> NICK iirc
  >> USER iirc 0 * iirc
```

**Exact replay** runs after every `play` and `replay`, without being asked. The inputs are folded again from `initial`, and each step's state, outputs, News, Inspection, and Knowledge must be the same, order included. Each is compared against a snapshot, a hash of its canonical text taken the moment the step first returned, never against the live values, so a Client that reuses or changes what it returned is caught, and a long scenario keeps a few bytes a step. On a mismatch, the diff is best effort. The replay's side is the very text its hash came from. The first run kept only a hash, so its side is rebuilt, from the state object it returned, the kit's copies of its outputs and News, or by calling `inspect` or `known` again, and shown as `played` only when it matches the recorded hash. When it does not, the error says so and shows the replay's text alone: a view that answers differently when called again "could not be rebuilt", and only a returned state that no longer hashes as it did "changed after it was returned". The kit's own copies of each step's outputs and News, in `Played.steps`, are cloned at once for the same reason. The Client gets its own copy of every input, and the kit keeps another to replay, so a step that changes its input, such as a Line's bytes or the Configuration, fails, in play and in replay. Every State must be plain data: strings, numbers, booleans, `null`, `undefined`, arrays, plain objects, `Map`, and `Set`, with no class instance, function, getter, symbol key, bigint, `Uint8Array`, `HashMap`, or cycle. An array holds only its elements, with no holes, getters, or other properties, and a `Map` or `Set` has no own property at all. No getter is ever run. A step that changes the state it was given fails too. `replayFresh` adds what one process cannot see, such as a hash order or a random number taken when a module loads.

## Preludes

Preludes write transcript text, and commit to how a Client registers. The Client is held to them.

| Helper | Example | Writes |
| --- | --- | --- |
| `configured(overrides)` | `configured({ channels: [{ name: "#iirc" }] })` | A base Configuration, decoded: `iirc` on `irc.test:6697` over TLS, enabled, no Channels, no login, nothing declined. |
| `registered(configuration, { offered, requested, isupport, server })` | `registered(base, { offered: ["sasl=PLAIN", "multi-prefix", "away-notify"], requested: ["sasl", "multi-prefix"] })` | `!! configure`, the dial it makes at once, `== opened`, `CAP LS 302`, `PASS` if configured, `NICK`, `USER`. `offered` is what the Ircd lists in `CAP LS`, with values. `requested` is what the Client is expected to `CAP REQ`, by name: the caps it has a Feature for, less those the Owner declined. Left out, it is every cap offered, so a simple scenario stays short. The Ircd acknowledges them, SASL `PLAIN` logs in when the Configuration has a login and `sasl` is requested, and `CAP END` follows, at once after `LS` when nothing is requested. Requesting a cap that is not offered throws. With nothing offered, the floor: `421` for `CAP`. Then `001` to `005`, 13 tokens to a `005`, `floorIsupport` by default. |
| `joined(configuration, channel, names, { nick, server })` | `joined(base, "#iirc", ["@peer"])` | `!! configure +#iirc`, `>> JOIN #iirc`, the echo, `353` with Self first, and `366`. |
| `across(caps)` | `across(["a", "b"])` | `[[], ["a"], ["b"], ["a", "b"]]`: none, each cap alone, and every pair. |

## The laws

Each law takes a `Subject`: the Client, its Configuration, its Features (`name`, `needs`, `keeps`), the caps to range over (by default every cap the Features need), and `transcript(caps)`, which writes the scenario with an Ircd that offers exactly those caps, usually with `registered(configuration, { offered: caps })`. The laws replay, so `requested` need not be exact there. Each runs `replay` for every set `across` gives, and throws `LawBrokenError` naming the law, the caps, and what differed. Every Knowledge and Inspection a law reads is copied, or written as canonical text, the moment it is obtained, so a Client that hands back one shared view cannot make two runs compare equal.

```ts
const subject = {
  client,
  configuration: base,
  features: [multiPrefix, serverTime],
  transcript: (caps) => registered(base, { offered: caps }) + joined(base, "#iirc", ["@peer"]),
};

inert(subject);
refines(subject);
replays(subject);
deactivates(subject, { after: () => "+1s\n<< :other!u@h JOIN #iirc\n" });
```

| Law | Holds when |
| --- | --- |
| `inert` | For each set of caps that leaves a Feature off, declining it changes no output, News, Knowledge, or Inspection. |
| `refines` | For each set and each larger one, every fact the smaller knows is in the larger, and goes only from unknown to stale to partial to known. What was established stays: a known value is the same, sets compared in any order, and a set holds every member of the partial set it refines. Knowledge is walked generically, so a fact added anywhere is checked. |
| `replays` | Every set replays exactly, with plain State. |
| `deactivates` | After `CAP DEL` of a cap, `after` gives the same outputs and News as never having had it, and the same Knowledge, whole, every leaf and key, except where the run that had the cap holds a fact marked stale. Anything inside a Stale fact may differ, its `was` and `since` included: scenarios check those, not the law. |

## Other helpers

- `scripted(script)`: a Client that answers each expected input with set outputs and News, and ignores anything else. It is for testing the Runtime without a real Client.
- `parse`, `print`, `printItem`: the format, for tools such as a recorder.
- `describeNews`, `describeOutput`: how News and outputs read in a transcript.
- `impurity(value)`: where a value stops being plain data, or `undefined`.
- `epoch`, `writeInstant`: the clock's start, and an instant as `t+13s`.

## Conventions the Client must keep

These are the Client's own rules, from [its README](../../README.md), which the kit relies on:

- A `Configured` or `Started` with the Network enabled dials at once. Only a redial after a `Closed` waits for backoff, and a `Configured` that disables the Network while connected hangs up.
- Connection ids start at 1 and go up by 1 for each `Dial`, never reused. The nth `-> dial` in a transcript is Connection n.
- Timers are one-shot, as `timers` projects them.
- It registers as `registered` writes it, requesting the caps it has a Feature for, less those declined.
