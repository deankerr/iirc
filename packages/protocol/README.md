# @iirc/protocol

Turns IRC bytes into Lines and builds Lines that are safe to send. Pure: no I/O, no Effect, no state.

- **Depends on:** nothing at run time.
- **Used by:** every other package.
- **Lineage:** irctokens.

## Public surface

Each module is its own export path, such as `@iirc/protocol/line`. There is no root export.

| Path | Main exports | Role |
| --- | --- | --- |
| `./frame` | `takeFrames`, `maxFrameBytes` | Splits a byte stream into frames, cutting any over 8704 bytes (HOST-2) |
| `./line` | `parseLine`, `parseFrame`, `pingToken`, `Line`, `Parsed` | Parses one frame without ever throwing. Falls back to Latin-1 when bytes are not UTF-8 |
| `./outbound` | `outbound`, `privmsg`, `quit`, `user`, `part`, `pong`, `encodeLine`, `OutboundLine` | Builds a Line that cannot smuggle in a second command, or says why it cannot |
| `./nick` | `nickCandidates`, `isNick`, `nickLine` | The fixed, finite list of nicks to try (CONN-4) |
| `./join` | `joinBatches`, `joinLines`, `channelKey`, `isChannelName`, `joinRejection` | `JOIN` Lines by byte length, keyed Channels first (SEND-11), and the ASCII fold Configuration compares Channels by |
| `./flood` | `fullBucket`, `nextSendAt`, `takeToken` | A token bucket held as the time it is next full (SEND-2) |
| `./login` | `loginSign` | Whether a Line is a sign that a login to services worked or failed (CONN-6) |
| `./template` | `parseTemplate`, `buildTemplate`, `templateReferences`, `fillReferences` | Connect commands with `{{name}}` references, parsed before anything is filled in (CONN-6) |

## Usage

```ts
import { parseFrame } from "@iirc/protocol/line";
import { encodeLine, privmsg } from "@iirc/protocol/outbound";

const parsed = parseFrame(new TextEncoder().encode(":alice!a@host PRIVMSG #iirc :hi"));

if (parsed._tag === "Line") {
  console.log(parsed.line.command, parsed.line.params); // PRIVMSG [ "#iirc", "hi" ]
}

const reply = privmsg("#iirc", "hello\r\nQUIT"); // a CR or LF can never reach the wire
if (reply._tag === "Safe") {
  const bytes = encodeLine(reply.line); // ends with CRLF, ready to write
} else {
  console.log(reply.reason); // "InvalidParameter"
}
```

## Key ideas

- **Parse, don't validate.** An `OutboundLine` exists only if it is safe to send. The only ways to get one are `outbound`, its helpers, and `pong`.
- **Parsing never throws.** Unparseable text comes back as `Unparseable` with its reason, and the text is always kept (HOST-1).
- **Bytes stay bytes where text would lie.** `pingToken` and `pong` echo a `PING` token byte for byte, whatever its encoding (LIVE-1).
- **Two ways to compare names.** `channelKey` is ASCII lower-casing, which can only split names, for where no Session gives a mapping. Within a Session, `@iirc/state` compares under the Ircd's `CASEMAPPING`.

## Invariants

- A Line from `outbound` holds no CR, LF, or NUL, has at most one trailing parameter, and fits in 510 bytes.
- `nickCandidates` never repeats a nick, and every candidate but the first fits the limit.
- `joinBatches` keeps each Channel's key aligned with it, and reports any Channel no `JOIN` can carry.

## Tests

- `src/testdata/msg-split.yaml` holds the ircdocs parser vectors (PROOF-2).

## Requirements

[Connecting](../../docs/requirements.md#connecting), [Staying connected](../../docs/requirements.md#staying-connected), [Sending](../../docs/requirements.md#sending), [Hostile input](../../docs/requirements.md#hostile-input). Message splitting (SEND-5 to SEND-8) belongs here, and is milestone 3.
