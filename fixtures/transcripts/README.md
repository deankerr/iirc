# Recorded transcripts

Real Sessions on real Ircds, written in the transcript format and replayed through the Client by `packages/client/src/scenarios/fixtures.test.ts`. The Client must register, follow each Session, and ignore nothing a correct Client would not. The `>>` Lines are the recorder's, not the Client's, so the replay does not match them.

| Fixture                     | What it records                                              |
| --------------------------- | ------------------------------------------------------------ |
| `ergo/first-features.irc`   | `CAP LS 302`, the first Features, and SASL PLAIN over TLS    |
| `ergo/floor.irc`            | No `CAP` at all, over plaintext                              |
| `ngircd/first-features.irc` | The same request, of which ngircd offers only `multi-prefix` |
| `ngircd/floor.irc`          | No `CAP` at all                                              |

They sit at the repository's root because no one package owns them: the Client's tests read them, and a recorder writes them.

## How they were made

A scripted Self and a scripted peer played one Session on a private Ergo 2.19.1 and a private ngircd, on loopback ports. The peer takes the nick `iirc` first, so Self meets a `433` and becomes `iirc_`. Then Self joins `#iirc`, the peer joins and talks, a Message goes each way in the Channel and directly, Self asks for `NAMES` and the Channel's modes, sends a `PING`, answers the Ircd's, and quits. The recorder is kept at the git tag `spike/transcript`, in `packages/transcript`. The planned recorder is the Daemon itself, run against a private Ircd as `bun run e2e` does, with its Journal printed through a normaliser that follows the rules below.

## Normalising

Every `<<` Line stays real bytes that a Client could receive, so a transcript feeds in as inputs without a matcher. Volatile values are substituted, never wildcarded, and the rules find them from structure, never from text:

| What | Rule |
| --- | --- |
| `time` tag | Moved onto the transcript's clock, which starts at `2026-01-01T00:00:00.000Z` when Self dials, and rounded to the second |
| `msgid` tag | `m1`, `m2`, … in order of first sight, the same stand-in every time the same id appears |
| `batch` tag and `BATCH ±ref` | `b1`, `b2`, … the same way |
| Tag order | Sorted by key, since Ergo writes tags in Go map order |
| `329` and `333` timestamps | Whole seconds from the second Self dialled |
| `353` names | Sorted by nick, with prefixes kept, since Ergo lists them in map order |
| `003`'s text | `This server was created at the epoch` |
| `250`'s text | `Highest connection count: 2`, since ngircd counts readiness checks |
| Hostnames | Stable by configuration, with no cloaking and no DNS, so every host is `127.0.0.1` |
| Ports | `-> dial` names the Ircd and its well-known port, such as `ergo.test:6697 tls`, not the port chosen for the run |
| Credentials | A Line that carried one is written as its placeholder, such as `>> AUTHENTICATE {AuthenticatePlain iirc}`, and never as bytes |

`+Ns` steps come from the recorded gaps, each event rounded from the dial rather than from the event before, so jitter never builds up. The peer's Lines are dropped, except its sends, which become `# peer >>` comments so a reader sees why a Line arrived.

## What they show

Ergo and ngircd are two examples of what the protocol allows, not its two cases. Each difference here is a freedom any Ircd may take, so the Client accepts it from every Ircd:

- **`433` comes at different times.** Ergo with `CAP` holds the nick check until `CAP END`, after SASL's `903`. ngircd answers as soon as it reads `NICK`, even mid-negotiation. A Client must handle `433` at any point before `001`.
- **Some Ircds pace us.** ngircd advertises `PENALTY` and held a reply for 2 seconds after our second `NICK`.
- **`PING` and `PONG` differ in shape.** Ergo sends `PING iirc_` with no source, and ngircd `PING :ngircd.test`. A Client echoes the token parameter and reads a reply's last parameter, never its colon.
- **A trailing colon is not meaning.** Ergo sends `JOIN #iirc`, and ngircd `JOIN :#iirc`.
- **Self's mask may come late.** ngircd's `001` ends with Self's full mask. Ergo's does not, so it comes from the echo of our `JOIN`.
- **`CAP LS` can span Lines,** with `*` on all but the last, and caps can carry values, such as `sasl=PLAIN,EXTERNAL,SCRAM-SHA-256`.
- **Not every Line is tagged.** With `server-time`, Ergo still sends `CAP LS`, `AUTHENTICATE +`, `BATCH`, and `ERROR` without `time`.
- **`labeled-response` has two shapes.** A one-Line reply carries `label` itself. A reply of many Lines comes as a batch, and only its `BATCH +` Line carries the label.
- **SASL's numerics come before registration,** with `*` for the nick: `900 * * iirc` and `903 *`.
- **Quitting differs.** Ergo echoes our own `QUIT`, then sends `ERROR`. ngircd sends a statistics `NOTICE`, then `ERROR`. Both then close cleanly.
- **ISUPPORT differs where it matters.** ngircd has `NICKLEN=9` and `CHANTYPES=#&+`. Ergo has `UTF8ONLY`, `NICKLEN=32`, and three `005` Lines.
