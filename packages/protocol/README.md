# @iirc/protocol

The IRC protocol as values: Lines in, Lines out, the places a Credential can go, and readers for what Lines carry. It is pure, and depends on no other package of ours.

This README is the module's written interface. Each subpath is its own module, and there is no root export.

| Subpath | What it holds |
| --- | --- |
| `@iirc/protocol/line` | The Line types, `parse`, `encode`, `outbound`, the builders, and `fillSecret` |
| `@iirc/protocol/isupport` | `RPL_ISUPPORT` tokens, and readers for the token values the protocol fixes |
| `@iirc/protocol/casemapping` | How a Network compares nicks and Channel names |
| `@iirc/protocol/ctcp` | CTCP read out of a Message's text, and CTCP text and Lines to send |
| `@iirc/protocol/format` | mIRC formatting codes as spans of text and style, or stripped |

## Features, from the floor up

The floor is RFC 1459 and 2812 as [Modern IRC](../../docs/irc-docs-2026-10-26/modern/client-protocol.md) describes them ([ADR 0001](../../docs/adr/0001-the-rfc-protocol-is-the-floor.md)). What sits above it is used only when an Ircd offers it, and nothing here depends on it.

1. **Parsing a Line.** `parse` reads the grammar at the byte level: an optional source, a command, middle parameters, and a trailing parameter with or without its colon. Runs of spaces count as one, spaces before the first part are skipped, and any number of parameters is read. A Line ends at its first NUL, CR, or LF. Commands are upper-cased in ASCII. Bytes with no command are `Unparseable`, as `Empty` or `NoCommand`, and nothing throws.
2. **Decoding.** Each part of a Line is decoded on its own, so one part in another encoding leaves the rest readable. Under `Utf8OrElse`, a part is UTF-8 if it is valid UTF-8, else in the fallback if it is valid there, else ISO-8859-1 byte for byte, which reads anything. Under `Utf8Only`, what `UTF8ONLY` promises, bytes that are not UTF-8 read as U+FFFD. A byte order mark is kept.
3. **Sources.** `parseSource` splits `nick!user@host`, where a server's name is all nick.
4. **Sending.** `outbound` builds an `OutboundLine` or says why it cannot, and `encode` gives its bytes with CRLF, writing the last parameter as trailing only when it must be. The builders cover the Lines a Client sends: `nick`, `user`, `join`, `part`, `privmsg`, `notice`, `quit`, `ping`, `pong`, `names`, `mode`, `who`, and `away` on the floor, and `cap`, `authenticate`, `tagmsg`, and `withTags` above it.
5. **Credentials.** `fillSecret` fills `PASS` and a `JOIN` with a key on the floor, and the SASL `PLAIN` response above it.
6. **CTCP.** `parseCtcp` reads `ACTION`, `DCC`, and other CTCP, with or without the closing `\x01`. `ctcpText`, `action`, `parseReplyTarget`, and `ctcpReply` build CTCP that is safe to send, and a reply only ever to a User.
7. **Formatting.** `parseFormatting` reads bold, italic, underline, strikethrough, monospace, reverse, reset, palette colours, and hex colours into spans, and `stripFormatting` removes exactly the codes it reads. Spans are data for a Frontend to draw, never markup.
8. **ISUPPORT.** `isupportTokens` reads one `005`'s tokens, set or taken back, with `\xHH` escapes undone as bytes. `prefixOf`, `channelModesOf`, `chantypesOf`, `modesOf`, `limitOf`, `limitsOf`, and `targetLimitsOf` read the values whose shape the protocol fixes, each with its default when the token is not sent.
9. **Casemapping.** `casemappingOf` reads `CASEMAPPING` and `UTF8MAPPING`, and `casefold` and `sameName` compare names under `ascii`, `rfc1459`, `rfc1459-strict`, or `rfc8265`.
10. **Message tags** (IRCv3 `message-tags`). `parse` reads tags in any order, as UTF-8, with their escapes undone. A key is an opaque name that is never refused, and the last of a repeated key wins. An `OutboundLine` carries client-only tags, and `label`, `batch`, and `draft/multiline-concat`, which `labeled-response` and `draft/multiline` need.

## `@iirc/protocol/line`

### Types

| Type | What it is |
| --- | --- |
| `Line` | One received Line, parsed: tags, source, command, and parameters. Anything that parses is a Line. |
| `Parsed` | A `Line`, or `Unparseable` with a reason. |
| `Encoding` | How bytes become text: `Utf8Only`, or UTF-8 or else a fallback encoding named by its WHATWG label. |
| `FallbackEncoding` | A WHATWG label this runtime can read with. UTF-16, `x-user-defined`, and `replacement` are refused. |
| `OutboundLine` | A Line that is safe to send. It cannot inject a second Line, it fits, and it parses back the same. |
| `Rejected` | Why a Line cannot be sent, as a `RejectedReason`. |
| `CredentialName` | The name of a Credential, which the Vault holds. |
| `SecretLine` | A Line with a Credential's name where its value goes: `Pass`, `AuthenticatePlain`, or `JoinWithKey`. |
| `Source` | A source's parts: nick, user, and host. |

`Encoding`, `OutboundLine`, and `SecretLine` are Schemas, because the Journal records them. Decoding a recorded `OutboundLine` checks it again.

### Functions

```ts
parse(bytes: Uint8Array, encoding: Encoding): Parsed
parseSource(source: string): Source
encode(line: OutboundLine): Uint8Array              // with CRLF
outbound(command, params, tags = {}): OutboundLine | Rejected
withTags(line: OutboundLine, tags): OutboundLine | Rejected
isRejected(result): result is Rejected
fillSecret(line: SecretLine, value: Redacted<string>): readonly OutboundLine[] | Rejected

// Builders, each OutboundLine | Rejected
privmsg(target, text)   notice(target, text)   tagmsg(target, tags)
join(channels)          part(channel, reason?)  quit(reason?)
nick(name)              user(username, realname)
cap("LS" | "LIST" | "REQ" | "END", argument?)   authenticate(argument)
ping(token)             pong(token)
names(channel)          mode(target, args?)     who(mask, fields?)   away(reason?)
```

`RejectedReason` is one of `InvalidCommand`, `InvalidParameter`, `TooManyParameters`, `TooLong`, `InvalidTag`, `TagsTooLong`, `InvalidTarget`, and `EmptyText`.

A builder that names a Target, a Channel, or a nick refuses a list, a space, a line break, or an empty name with `InvalidTarget`, so it names one thing. `join` refuses `0`, which leaves every Channel. A Channel with a key goes through the `JoinWithKey` `SecretLine`. Which Channels share a `JOIN`, and how a long Message or `CAP REQ` is split, are the caller's to choose.

## `@iirc/protocol/isupport`

```ts
isupportTokens(params: readonly string[]): readonly IsupportToken[]   // Set { name, value } | Removed { name }
unescapeValue(value: string): string
prefixOf(value?): readonly Membership[] | undefined    // (ov)@+ when not sent, [] when empty
channelModesOf(value?): ChannelModes                   // { list, always, whenSet, flags }
chantypesOf(value?): string                            // #& when not sent
modesOf(value?): number | undefined                    // 3 when not sent, undefined for no limit
limitOf(value?): number | undefined                    // NICKLEN, TOPICLEN, and the other lengths
limitsOf(value?): readonly Limit[]                     // CHANLIMIT and MAXLIST pairs
targetLimitsOf(value?): ReadonlyMap<string, number | undefined>   // TARGMAX
```

`isupportTokens` takes all of a `005`'s parameters. The first is Self and the last is text for people, so neither is read. Which tokens a Session holds is the caller's to keep, and to bound.

## `@iirc/protocol/casemapping`

```ts
casemappingOf(casemapping?: string, utf8mapping?: string): Casemapping | undefined
casefold(casemapping: Casemapping, name: string): string
sameName(casemapping: Casemapping, left: string, right: string): boolean
```

With neither token sent, the mapping is `rfc1459`. A mapping this module does not know is `undefined`, and a caller that must still compare should use `ascii`, which can split one name in two but never merges two. `casefold` touches nothing past ASCII, so `rfc8265` folds ASCII only: its full mapping needs Unicode's case tables, which would have to be pinned in this module to stay the same on every runtime.

## `@iirc/protocol/ctcp`

```ts
parseCtcp(text: string): Ctcp      // NotCtcp | Action { text } | Dcc { subcommand, args } | Other { command, args }
ctcpText(command, args): CtcpText | { _tag: "Rejected", reason: "InvalidCommand" | "InvalidArguments" }
action(target, text): OutboundLine | Rejected
parseReplyTarget(nick, { chantypes, statusmsg }): ReplyTarget | undefined
ctcpReply(target: ReplyTarget, text: CtcpText): OutboundLine | Rejected
```

`parseCtcp` acts on nothing: whether to answer is the caller's choice, and a `DCC` is only read. It ignores anything after the closing `\x01`, and does not undo low-level quoting. Whether it is a request or a reply is for the carrying command to say. A reply goes only to a `ReplyTarget`, a nick that could name nothing but a User, so a forged source such as `#victims!u@h` cannot turn a reply into a `NOTICE` to a Channel or a mask.

## `@iirc/protocol/format`

```ts
parseFormatting(text: string): readonly Span[]   // { text, style }
stripFormatting(text: string): string
plainStyle: Style
```

A colour of `99` is the default colour, so it is `undefined` in a `Style`. A colour code with no colour after it resets both colours and takes nothing else, so `\x03,` shows the comma. A `\x04` needs exactly six hex digits. Reverse is a flag, and does not swap the colours.

## Invariants

- **Total.** Nothing here throws. Bytes that do not parse give `Unparseable`, and a Line that cannot be sent safely gives `Rejected`.
- **Pure.** No clock, randomness, locale, time zone, environment, or I/O. Decoding uses the runtime's `TextDecoder` and nothing else from it. Comparing names uses no `toLowerCase` past ASCII and nothing locale-aware.
- **Safe by construction.** An `OutboundLine` has no NUL, CR, LF, or lone surrogate anywhere, its command is upper-case letters or three digits, and only its last parameter may be empty, contain a space, or start with `:`. It has at most 15 parameters. Encoded, it fits in 512 bytes with its line ending, not counting tags, and its tags fit in 4094 bytes. Its tags are client-only, or `label`, `batch`, and `draft/multiline-concat`.
- **Round trip.** Parsing an encoded `OutboundLine` gives back its command, parameters, and tags.
- **One place for Credentials.** `fillSecret` is the only code that puts a Credential's value into a Line. It splits the SASL `PLAIN` response into `AUTHENTICATE` Lines of 400 bytes of payload, and ends it with `AUTHENTICATE +` when the last is full, which is also the whole of an empty one. Its result is sent and never journaled. The Journal records the `SecretLine`, which holds only the name. A value that cannot be sent, such as one with a line break, or a key with a space or a comma, is `Rejected`.
- **Where SASL goes next.** `SCRAM-SHA-256` would land in `SecretLine`: its replies depend on the Ircd's challenge, a nonce, and keys derived from the Credential, so it needs cases that take the challenge, or an exchange run on the Runtime's side. `EXTERNAL` needs no `SecretLine`, because its Credential is a client certificate that `Dial` would name.
- **Structure, not text.** Nothing here reads an Ircd's free text to decide anything. The text that ends a `005` is never read.

## Traps

- `latin1` as a WHATWG label is `windows-1252`, which maps bytes `0x80` to `0x9f` to other characters. The last resort, when the fallback cannot read the bytes, is real ISO-8859-1, where each byte is the code point of the same value.
- `OutboundLine` holds text, and is encoded as UTF-8. A `PONG` echoes a token as it was parsed, so a token that was not UTF-8 is not echoed byte for byte.

## Tests

- `src/testdata/msg-split.yaml` holds the ircdocs parser vectors, and `formatting.yaml` and `ctcp.yaml` hold the formatting and CTCP vectors, in the same style.
- Every `<<` Line in `fixtures/transcripts/` parses, and every `>>` Line we sent there can be built and reads back the same.
- Property tests, with fast-check: `parse` never throws on arbitrary bytes, in any encoding; every `OutboundLine` round-trips, holds no NUL, CR, or LF but its line ending, and fits; every SASL `PLAIN` response is valid `AUTHENTICATE` Lines of at most 400 bytes of payload, with the `+` rule, that decode to the response; formatting, CTCP, ISUPPORT, and casemapping never throw, and agree with their other halves.

Tests read vectors and fixtures with Vite's `?raw` imports and Effect's YAML parser, so they need no file I/O.
