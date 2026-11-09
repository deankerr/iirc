# The transcript spike

Step 2 of [the architecture proposal](2026-11-07-architecture-proposal.md#2-spikes) asked for a private Ergo, a Transport that records, and a fixture format, with Sessions recorded with the first Features and with none. This note says what was built, what the format now decides, and what the real recorder and test kit should be.

The spike's code is on the branch `t3/transcript-format-spike`, in `packages/transcript`, and is ported from on purpose. The commands below run there. The fixtures and the format decisions are what last.

## What was built

- **A private Ergo.** `src/record/ircd.ts` takes Ergo 2.19.1 for Linux x86_64 from its GitHub release into the gitignored `.cache/ergo/`. It checks the tarball's SHA-256 against both the release's checksums file and a hash pinned in the code before anything in it runs. It writes a minimal config into a temporary directory: plaintext and TLS listeners on free loopback ports, a self-signed certificate for `ergo.test` made with `openssl`, a fresh database from `ergo initdb`, `sts` off, cloaking off, fakelag off, and a 10-second ping timeout. It registers the SASL account on a Connection that is not recorded, with `REGISTER` from `draft/account-registration`. The password is random per run and lives only in memory.
- **A private ngircd.** The same module runs `~/.local/opt/ngircd/ngircd --nodaemon` on its own generated config, on a free loopback port, with a 10-second `PingTimeout`. It refuses port 6667 outright. It never touches the shared ngircd or its service.
- **Cleanup.** Each Ircd is a child process, killed with `SIGKILL` and its directory removed in a `finally`, on `SIGINT` and `SIGTERM`, and on exit. Readiness is a TCP connect that succeeds, not a log line.
- **A recording Connection.** `src/record/link.ts` is a Bun TCP or TLS socket that frames Lines with the Transport port's rules (`src/framer.ts`, with its own tests) and appends every event to a `Recording`, timed from its start. TLS verifies the self-signed certificate against `ergo.test`, so nothing turns verification off. Server `PING`s are answered at once.
- **Scripted Sessions.** `src/record/scenario.ts` drives Self and a scripted peer with hand-written Lines. The peer takes the nick `iirc` first, so Self meets a 433 and becomes `iirc_`. Then Self joins `#iirc` and gets NAMES, the peer joins and talks, a Message goes each way in the Channel and directly, Self asks for NAMES again (in a `labeled-response` batch when it has the cap) and the Channel's modes (for a 329), sends a `PING`, answers the Ircd's `PING`, and quits. Every decision comes from commands, numerics, and parameters.
- **The format.** `src/transcript.ts` parses and prints transcripts, and `src/transcript.test.ts` checks every committed fixture.
- **A normaliser.** `src/record/normalize.ts` turns a Recording into transcript items and makes volatile values stable.

## Running it

```sh
bun run record:transcripts          # re-records every fixture, from the repository's root
bun packages/transcript/src/record/main.ts --raw   # prints them without normalising
bun run test                        # parses the fixtures; opens no socket
```

Recording takes about a minute, most of it waiting for each Ircd's `PING`. Two runs in a row write identical fixtures.

## The fixtures

| Fixture | What it records |
| --- | --- |
| `fixtures/transcripts/ergo/first-features.irc` | `CAP LS 302`, all eight first Features, SASL PLAIN over TLS |
| `fixtures/transcripts/ergo/floor.irc` | No `CAP` at all, plaintext |
| `fixtures/transcripts/ngircd/first-features.irc` | The same request, of which ngircd offers only `multi-prefix` |
| `fixtures/transcripts/ngircd/floor.irc` | No `CAP` at all |

They sit at the repository's root, not in a package, because the Client's tests will read them and the recorder writes them. Neither owns them.

## Format decisions

### Credentials

A Line that carries a Credential is never recorded as bytes. The script calls `sendSecret` with the `SecretLine`'s kind and the Credential's name, and the recording holds only those. The value goes to the socket and nowhere else:

```
>> AUTHENTICATE PLAIN
<< AUTHENTICATE +
>> AUTHENTICATE {AuthenticatePlain iirc}
```

A placeholder is read only after `AUTHENTICATE`, `JOIN`, or `PASS`, which are the commands a `SecretLine` renders. A Message whose text happens to end in braces stays an ordinary Line, and the printer escapes a sent Line that would read as a placeholder. As a second guard, the recorder refuses to write a transcript that contains the password or its PLAIN payload, and a test checks that no committed `AUTHENTICATE` or `PASS` Line has anything after it but `PLAIN`.

### Volatile values

**Substitute, don't wildcard.** Every `<<` Line stays real bytes that a Client could receive, so a transcript can be fed in as inputs without a matcher. The rules find what to replace from structure, never from text:

| What | Rule |
| --- | --- |
| `time` tag | Moved onto the transcript's clock and rounded to the second: `time=2026-01-01T00:00:13.000Z` |
| `msgid` tag | `m1`, `m2`, … in order of first sight, the same stand-in every time the same id appears |
| `batch` tag and `BATCH ±ref` | `b1`, `b2`, … the same way |
| Tag order | Sorted by key. Ergo writes tags in Go map order, which changes from run to run. |
| 329 and 333 timestamps | Counted in whole seconds from the second Self dialled. The recorder dials just after a wall-clock second begins, so the count is the same every run. |
| 353 names | Sorted by nick, prefixes kept. Ergo lists them in map order too. |
| 003's text | `This server was created at the epoch`, since it names when the Ircd started |
| 250's text | `Highest connection count: 2`, since ngircd counts the recorder's readiness checks |
| Hostnames | Made stable by config: no cloaking and no DNS, so every host is `127.0.0.1` |
| Ports | `-> dial` names the Ircd and its well-known port (`ergo.test:6697 tls`, `ngircd.test:6667`), not the one chosen for the run |
| Version strings | Kept. They say which Ircd made the recording, and they change only when we upgrade on purpose. |
| Nonces | None in PLAIN. Our own `PING` tokens and labels are fixed by the script. |

ngircd's quit `NOTICE` counts bytes in kilobytes. It is stable while the script is, so it is left alone.

### Time

`+Ns` steps come from the recorded gaps. The clock starts at 0 when Self dials, every event is placed at its whole second, rounded, and a step is written only when that second moves on. Jitter never builds up, because each event is rounded from the dial, not from the event before. The kit's fake clock must start at **2026-01-01T00:00:00.000Z**, the instant the normaliser maps the dial to, so `time` tags and the clock agree.

The recorder never writes `ms`, but the parser reads `+250ms` and `+2m` for hand-written scenarios.

### Connections and the peer

A transcript is Self's side of one run. Today that is one Connection, but nothing stops a run from having several: each `-> dial` and `== opened` begins the next one, and the kit gives each the next `ConnectionId`.

The peer's Lines are dropped, except its sends, which become comments so a reader sees why a Line arrived:

```
# peer >> PRIVMSG iirc_ :psst
<< @msgid=m5;time=2026-01-01T00:00:02.000Z :peer!~u@127.0.0.1 PRIVMSG iirc_ :psst
```

The peer's automatic `PONG`s are left out. The scripted Owner steps are written as `!!` inputs before the Lines they cause: `!! configure +#iirc`, `!! say #iirc :hello from iirc`.

### What the format gained

- **` tls` on `-> dial`.** `IrcdAddress` has `tls`, and the format had no way to say it: `-> dial ergo.test:6697 tls`.
- **An escaped form.** The Transport delivers bytes, not text. A Line that is not UTF-8, holds a control byte such as CTCP's `\x01`, or ends in a space is written `<<\ ` or `>>\ `, with `\\` and `\xNN`. Ergo's MOTD header ends in a space, so this was needed at once: `<<\ :ergo.test 375 iirc_ :- ergo.test Message of the day -\x20`.
- **A fixed epoch,** as above. It is a constant of the kit, not a header in each file.
- **Blank lines and `#` comments** are kept as items, so print-then-parse round-trips exactly.

### What it still lacks

- **A `SecretLine` has more than its Credential.** `AuthenticatePlain` also carries `authcid` and `authzid`, and the placeholder names neither, so a strict kit cannot check them. A PLAIN response over 400 bytes is also split over several `AUTHENTICATE` Lines, but the item is one `SendSecret`. I suggest the placeholder replace the whole item and carry every field but the value, such as `>> {AuthenticatePlain iirc authcid=iirc authzid=iirc}`. That is a change to the format only.
- **No Configuration before the dial.** A recorded transcript starts at `-> dial`, but a Client dials only after a `Configured` input. `!! configure +#iirc` is also a change to a Configuration, while `Configured` takes it whole. The kit needs a base Configuration per scenario, from a prelude, that `!! configure` verbs change.
- **Recorded `>>` Lines are the script's, not the Client's.** Strict matching will fail as soon as the real Client registers differently, which it will. See the recommendation.

No substrate type had to change. The framer follows `packages/runtime`'s Transport rules exactly. One thing the Transport README could say is that `Opened` comes after the TLS handshake, which is when Bun calls `open` for a TLS socket and when the recorder writes `== opened`.

## Ergo and ngircd, side by side

Ergo and ngircd are two examples of what the protocol allows, not its two cases. Each difference below is a freedom any Ircd may take, so the Client accepts it from every Ircd, including ones we have never recorded. Its logic follows the protocol's structure, never one Ircd's habits.

These are the differences that matter to the Client:

- **433 comes at different times.** Ergo with `CAP` holds the nick check until `CAP END`, so the 433 comes after SASL's 903. Without `CAP` it comes right after `USER`. ngircd answers the second we send `NICK`, even mid-negotiation and before its `CAP ACK`. The Client must handle 433 at any point before 001.
- **ngircd paces us.** After our second `NICK` it held its next reply for 2 seconds (it advertises `PENALTY`): the `CAP ACK` in one run and the 001 in the other. Several later replies came about a second late. Ergo, with fakelag off, answered at once. Pacing per Ircd is real (§8.2 of the proposal).
- **`PING` and `PONG` differ in shape.** Ergo sends `PING iirc_`, with our nick as the token and no source. ngircd sends `PING :ngircd.test`. Ergo replies `:ergo.test PONG ergo.test iirc-1` with no colon, and ngircd `:ngircd.test PONG ngircd.test :iirc-1`. A Client echoes the token parameter and reads the reply's last parameter, never its colon.
- **Trailing colons are not meaning.** Ergo sends `JOIN #iirc`, and ngircd `JOIN :#iirc`.
- **Self's mask.** ngircd's 001 ends with `iirc_!~iirc@127.0.0.1`. Ergo's does not, so Self's mask comes from the echo of our JOIN.
- **`CAP LS` can span Lines.** Ergo splits it over two, with `*` on the first, and gives values: `sasl=PLAIN,EXTERNAL,SCRAM-SHA-256`. ngircd sends one Line, `multi-prefix`, and nothing else.
- **Not every Line is tagged.** With `server-time`, Ergo still sends `CAP LS`, `AUTHENTICATE +`, `BATCH`, and `ERROR` without `time`. A Client cannot assume every Line has a time.
- **`labeled-response` has two shapes.** A one-Line reply, such as the echo of our `PRIVMSG`, carries `label` itself. A reply of many Lines, such as NAMES, comes as a batch, and only the `BATCH +b1 labeled-response` Line carries the label.
- **SASL's numerics come before registration,** with `*` for the nick: `900 * * iirc` and `903 *`.
- **Quitting.** Ergo echoes our own `QUIT`, with or without `echo-message`, and then sends `ERROR`. ngircd sends a statistics `NOTICE` and then `ERROR`. Both then close cleanly, so the Connection ends `Ended`.
- **ISUPPORT differs where it matters.** ngircd has `NICKLEN=9` and `CHANTYPES=#&+`. Ergo has `UTF8ONLY`, `NICKLEN=32`, and three 005 Lines. ngircd's channel has no default modes (`324 … +`), and Ergo's has `+nt`.

## What surprised me

- **GitHub served 504s while I recorded.** `fetch` handed back the error page as the body, as `fetch` does, and the first script did not check the status. The hash check caught it before anything ran. The script now uses `curl --fail` with retries and reuses release files already in `.cache/ergo/`.
- **Ergo is not deterministic in order.** Tags and NAMES come out in Go map order. Normalising order away was the only way to make re-recording stable.
- **Our own Lines raced the Ircd's.** Sending the next step as soon as the awaited Line arrived let it land before the rest of that reply, such as `BATCH -b1`, and the order changed from run to run. Each step now waits a quarter-second for the Ircd to go quiet.
- **Whole-second timestamps cannot be rounded stably** against a clock that starts mid-second. Dialling just after a second begins fixed it.
- **ngircd counts our readiness checks** in 250's text.
- **Ergo marks loopback as secure.** Its 221 is `+Zi` even on the plaintext floor run.

## Recommendation

**Make a transcript a projection of the Journal.** The Journal already holds every input and output in order (ADR 0002), with times. A transcript is a view of it: `Received`, `Opened`, and `Closed` inputs print as `<<` and `==`, `Send`, `SendSecret`, `Dial`, and `Hangup` outputs print as `>>` and `->`, and the gaps between `at`s print as `+Ns`. So the real recorder is not a separate Transport. It is the Daemon, with the real `transport-bun`, run against a private Ircd, and its Journal printed through the normaliser. What the Client really sent is then what the transcript says, and re-recording after the Client changes how it registers is one command. Don't sync state. Derive it.

For that:

1. **Port the format module** to `@iirc/client/testing`, with the additions above and the whole-item `SecretLine` placeholder.
2. **Port the normaliser** as a pure function from Journal Entries to items, with its rules keyed by tag, numeric, and position as listed here, and a raw mode.
3. **Port `ircd.ts`** as the end-to-end harness, rewritten in Effect with `Scope` for the child processes and temporary directories. Keep the pinned hash and the private ports.
4. **Give the kit two ways to use a recording.** `replay` feeds the `<<`, `==`, and `+Ns` items to the Client and checks that nothing is `Ignored` and that it registers. A strict scenario also matches every `>>`. Recorded fixtures are replayed, and hand-written scenarios are strict.
5. **Record Solanum, InspIRCd, and UnrealIRCd next** (§8.4), with the same scripted peer, now that the format holds.
