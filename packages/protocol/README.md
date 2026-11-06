# @iirc/protocol

Turns IRC bytes into Lines and builds Lines that are safe to send, and reads what Lines carry: formatting, CTCP, and standard replies. Pure: no I/O, no Effect, no state.

- **Depends on:** nothing at run time.
- **Used by:** every other package.
- **Lineage:** irctokens.

## Public surface

Each module is its own export path, such as `@iirc/protocol/line`. There is no root export.

| Path | Main exports | Role |
| --- | --- | --- |
| `./frame` | `takeFrames`, `maxFrameBytes` | Splits a byte stream into frames, cutting any over 8704 bytes (HOST-2) |
| `./line` | `parseLine`, `parseFrame`, `pingToken`, `Line`, `Parsed` | Parses one frame without ever throwing. Falls back to Latin-1 when bytes are not UTF-8 |
| `./outbound` | `outbound`, `privmsg`, `notice`, `quit`, `user`, `part`, `channelRead`, `pong`, `encodeLine`, `OutboundLine` | Builds a Line that cannot smuggle in a second command, or says why it cannot |
| `./decode` | `decodeBytes`, `parseFallbackEncoding`, `Decoded`, `FallbackEncoding` | Bytes to text: UTF-8, then the configured fallback, then Latin-1. Never fails, and says which it used (MSG-4) |
| `./format` | `parseFormatting`, `stripFormatting`, `plainStyle`, `Span`, `Style`, `Colour` | mIRC formatting codes as spans of text and style, or stripped (MSG-3) |
| `./ctcp` | `parseCtcp`, `ctcpText`, `ctcpReply`, `Ctcp`, `CtcpText` | Reads `ACTION`, `DCC`, and other CTCP out of a Message's text, and builds a CTCP reply that is safe to send (PROT-2, PROT-5) |
| `./replies` | `parseStandardReply`, `StandardReply` | `FAIL`, `WARN`, and `NOTE` Lines as kind, command, code, context, and description (PROT-6) |
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
- **Decoding is a parsed choice.** A `FallbackEncoding` exists only for a label the runtime knows. `decodeBytes` tries UTF-8, then the fallback, then Latin-1, which reads any bytes, so it cannot fail.
- **Formatting and CTCP are data.** `parseFormatting` gives spans a Frontend draws, never markup. `parseCtcp` names what a Message holds and acts on nothing, so a `DCC` is only ever recorded. A `CtcpText` exists only if it holds no `\x01`, CR, LF, or NUL inside.
- **Decide from shape.** `parseStandardReply` reads the parameters' positions, never the words in a description.
- **Bytes stay bytes where text would lie.** `pingToken` and `pong` echo a `PING` token byte for byte, whatever its encoding (LIVE-1).
- **Two ways to compare names.** `channelKey` is ASCII lower-casing, which can only split names, for where no Session gives a mapping. Within a Session, `@iirc/state` compares under the Ircd's `CASEMAPPING`.

## Traps

- `latin1` as a `TextDecoder` label is `windows-1252`, which maps bytes `0x80` to `0x9f` to other characters. `decodeBytes` falls back to real ISO-8859-1, where each byte is the code point of the same value. `parseFallbackEncoding("latin1")` gives `windows-1252`. `parseFrame`'s own fallback still uses the WHATWG label, until `decodeBytes` replaces it.
- `x-user-defined` is refused as a fallback, because Bun drops every byte above `0x7f` when it decodes.
- A colour of `99` is the default colour, so it is `undefined` in a `Style` and not a `Palette` colour.
- A colour code with no colour after it resets both colours and consumes nothing else, so `\x03,` shows the comma and `\x0312,x` shows `,x`. A `\x04` needs exactly six hex digits to count as a colour.
- Reverse is a flag. It does not swap the colours.
- `parseCtcp` ignores anything after the closing `\x01`, does not undo low-level quoting, and is the same for `PRIVMSG` and `NOTICE`. Whether it is a request or a reply is for the carrying command to say.

## Invariants

- A Line from `outbound` holds no CR, LF, or NUL, has at most one trailing parameter, and fits in 510 bytes.
- `nickCandidates` never repeats a nick, and sends each one as configured.
- `stripFormatting` removes exactly what `parseFormatting` reads as a code, so the spans' text joined is the stripped text. No span is empty, and none follows another with the same style.
- Every `FAIL`, `WARN`, and `NOTE` Line with three parameters or more reads, and no other Line does.
- `joinBatches` keeps each Channel's key aligned with it, and reports any Channel no `JOIN` can carry.

## Tests

- `src/testdata/msg-split.yaml` holds the ircdocs parser vectors (PROOF-2).
- `src/testdata/formatting.yaml` and `src/testdata/ctcp.yaml` hold the formatting (MSG-3) and CTCP (PROT-2, PROT-5) vectors, in the same style.
- Each parser also runs over thousands of seeded random strings or bytes, which must never throw and must agree with their other half, such as strip against parse (PROOF-2).

## Requirements

[Connecting](../../docs/requirements.md#connecting), [Staying connected](../../docs/requirements.md#staying-connected), [Sending](../../docs/requirements.md#sending), [Hostile input](../../docs/requirements.md#hostile-input), and [Messages and Activity](../../docs/requirements.md#messages-and-activity) (MSG-3, MSG-4) and [Protocol behaviour](../../docs/requirements.md#protocol-behaviour) (PROT-2, PROT-5, PROT-6). Message splitting (SEND-5 to SEND-8) belongs here, and is milestone 3.
