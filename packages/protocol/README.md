# @iirc/protocol

The IRC protocol as values: Lines in, Lines out, the places a Credential can go, and readers for what Lines carry. It is pure, and depends on no other package of ours.

Each subpath is its own module, and there is no root export.

| Subpath | What it holds |
| --- | --- |
| `@iirc/protocol/line` | The Line types, `parse`, `encode`, `outbound`, the builders, and `fillSecret` |
| `@iirc/protocol/isupport` | `RPL_ISUPPORT` tokens, and readers for the token values the protocol fixes |
| `@iirc/protocol/casemapping` | How a Network compares nicks and Channel names |
| `@iirc/protocol/ctcp` | CTCP read out of a Message's text, and CTCP text and Lines to send |
| `@iirc/protocol/format` | mIRC formatting codes as spans of text and style, or stripped |

## Features, from the floor up

The floor is RFC 1459 and 2812 as Modern IRC describes them. What sits above it is used only when an Ircd offers it, and nothing here depends on it.

1. **Parsing a Line.** `parse` reads the grammar at the byte level: an optional source, a command, middle parameters, and a trailing parameter with or without its colon. Runs of spaces count as one, spaces before the first part are skipped, and any number of parameters is read. The Transport hands over Lines split at CR or LF, so a Line's bytes hold neither; should one hold a CR, LF, or NUL anyway, the Line ends there. Commands are upper-cased in ASCII. Bytes with no command are `Unparseable`, as `Empty` or `NoCommand`, and nothing throws.
2. **Decoding.** Each part of a Line is decoded on its own, so one part in another encoding leaves the rest readable. Under `Utf8OrElse`, a part is UTF-8 if it is valid UTF-8, else in the fallback if it is valid there, else ISO-8859-1 byte for byte, which reads anything. Under `Utf8Only`, what `UTF8ONLY` promises, bytes that are not UTF-8 read as U+FFFD. A byte order mark is kept.
3. **Sources and raw parameters.** `parseSource` splits `nick!user@host`, where a server's name is all nick. `rawParams` gives each parameter as the bytes that arrived, as a `RawParam`, split exactly as `parse` splits them, so a `PING` token that is not UTF-8 can be echoed byte for byte.
4. **Sending.** `outbound` builds an `OutboundLine` or says why it cannot, and `encode` gives its bytes with CRLF, writing the last parameter as trailing only when it must be. A parameter is text, sent as UTF-8, or a `RawParam`, sent as its bytes, which `pong` uses to echo a token exactly. The builders cover the Lines a Client sends: `nick`, `user`, `join`, `part`, `privmsg`, `notice`, `quit`, `ping`, `pong`, `names`, `mode`, `who`, `whois`, `whowas`, `away`, `topic`, `kick`, and `invite` on the floor, and `cap`, `authenticate`, `tagmsg`, and `withTags` above it. `quote` builds a Line from text, as `/quote` takes it.
5. **Credentials.** `fillSecret` fills `PASS` and a `JOIN` with a key on the floor, and the SASL `PLAIN` response above it.
6. **CTCP.** `parseCtcp` reads `ACTION`, `DCC`, and other CTCP, with or without the closing `\x01`. `ctcpText`, `action`, `parseReplyTarget`, and `ctcpReply` build CTCP that is safe to send, and a reply only ever to a User.
7. **Formatting.** `parseFormatting` reads bold, italic, underline, strikethrough, monospace, reverse, reset, palette colours, and hex colours into spans, and `stripFormatting` removes exactly the codes it reads. Spans are data for a Frontend to draw, never markup.
8. **ISUPPORT.** `isupportTokens` reads one `005`'s tokens, set or taken back, with `\xHH` escapes undone as bytes. `prefixOf`, `channelModesOf`, `chantypesOf`, `statusmsgOf`, `modesOf`, `limitOf`, `limitsOf`, and `targetLimitsOf` read the values whose shape the protocol fixes, each with its default when the token is not sent.
9. **Casemapping.** `casemappingOf` reads `CASEMAPPING` and `UTF8MAPPING`, and `casefold` and `sameName` compare names under `ascii`, `rfc1459`, `rfc1459-strict`, or `rfc8265`.
10. **Message tags** (IRCv3 `message-tags`). `parse` reads tags in any order, as UTF-8, with their escapes undone. A key is an opaque name that is never refused, and the last of a repeated key wins. An `OutboundLine` carries client-only tags, and `label`, `batch`, and `draft/multiline-concat`, which `labeled-response` and `draft/multiline` need.

## `@iirc/protocol/line`

### Types

| Type | What it is |
| --- | --- |
| `Line` | One received Line, parsed: tags, source, command, and parameters. Anything that parses is a Line. |
| `Parsed` | A `Line`, or `Unparseable` with a reason. |
| `Encoding` | How bytes become text: `Utf8Only`, or UTF-8 or else a fallback encoding named by its WHATWG label. |
| `FallbackEncoding` | One of a fixed list of WHATWG encodings, by canonical name, such as `windows-1252` or `shift_jis`. It is a list rather than whatever the runtime knows, so a recorded Configuration means the same on every runtime. UTF-8, UTF-16, `x-user-defined`, `replacement`, and ISO-2022-JP, which is 7-bit and so always reads as UTF-8 first, are not in it. `missingDecoders()` lists any this runtime cannot decode, and whatever processes or replays a Journal refuses to start unless it is empty. Decoders still differ between runtimes on some bytes (Bun and Node read `big5` `0xff` differently), so replay is exact on the pinned Bun in the root `package.json`. Upgrading Bun is like a parser fix (ADR 0002): history may read differently afterwards, on purpose. |
| `OutboundLine` | A Line that is safe to send. It cannot inject a second Line, it fits, and it parses back the same. |
| `Rejected` | Why a Line cannot be sent, as a `RejectedReason`. |
| `CredentialName` | The name of a Credential, which the Vault holds. Its identifier, `CredentialName`, marks every field it types, so a Frontend walking a Schema shows such a field by name and never asks for its value back. |
| `SecretLine` | A Line with a Credential's name where its value goes: `Pass`, `AuthenticatePlain`, or `JoinWithKey`. |
| `Source` | A source's parts: nick, user, and host. |
| `Param` | A parameter to send: text, sent as UTF-8, or a `RawParam`, sent as its bytes. |
| `RawParam` | `{ bytes: string }`: bytes as a binary string, one code unit per byte from 0 to 255. A string cannot change once it is checked, so no buffer is shared with a caller, and it is plain data a Client can keep in its State. |

`Encoding`, `OutboundLine`, `Param`, and `SecretLine` are Schemas, because the Journal records them. A `RawParam`'s binary string is recorded as it is, and a string with a code unit past 255 is refused, so an `OutboundLine` holds no `Uint8Array` anywhere. Decoding a recorded `OutboundLine` checks it again.

### Functions

```ts
parse(bytes: Uint8Array, encoding: Encoding): Parsed
parseSource(source: string): Source
rawParams(bytes: Uint8Array): readonly RawParam[]     // each parameter as it arrived
encode(line: OutboundLine): Uint8Array | Rejected   // with CRLF; the one guard on what leaves
outbound(command, params: readonly Param[], tags = {}): OutboundLine | Rejected
withTags(line: OutboundLine, tags): OutboundLine | Rejected
isRejected(result): result is Rejected
fillSecret(line: SecretLine, value: Redacted<string>): readonly OutboundLine[] | Rejected

// Builders, each OutboundLine | Rejected
privmsg(target, text)   notice(target, text)   tagmsg(target, tags)
join(channels)          part(channel, reason?)  quit(reason?)
nick(name)              user(username, realname)
cap("LS" | "LIST" | "REQ" | "END", argument?)   authenticate(argument)
ping(token)             pong(token: string | RawParam | Uint8Array)
names(channel)          mode(target, args?)     who(mask, fields?)   away(reason?)
whois(nick)             whowas(nick)
topic(channel, text)    kick(channel, nicks, reason?)               invite(nick, channel)
quote(text)             // a Line written as text, read by `parse` and built again
```

`RejectedReason` is one of `InvalidCommand`, `InvalidParameter`, `TooManyParameters`, `TooLong`, `InvalidTag`, `TagsTooLong`, `InvalidTarget`, `EmptyText`, and `Unparseable`.

A builder that names a Target, a Channel, or a nick refuses a list, a space, a line break, or an empty name with `InvalidTarget`, so it names one thing. `join` refuses `0`, which leaves every Channel. A Channel with a key goes through the `JoinWithKey` `SecretLine`. Which Channels share a `JOIN`, which nicks share a `KICK`, how modes are split across `MODE` Lines, and how a long Message or `CAP REQ` is split, are the caller's to choose.

- `mode` takes each argument as one word: one that is empty, holds a space, or starts with `:` is `InvalidParameter`, since it would not read back as one parameter.
- `topic` with `""` clears the topic, and is sent as `TOPIC #chan :`, since `TOPIC #chan` with no topic asks for it instead.
- `kick` takes one or more nicks, each a nick as `nick` takes one, as one list, and leaves out a reason that is empty.
- `whois` and `whowas` take one nick, as `nick` takes one, so neither sends a mask, a list, or an empty name. Each is sent with that one parameter and no server to ask. A name with a `.`, such as `irc.example.com`, is a nick by those rules, so it is sent as a `WHOIS` of that nick, and the Ircd decides what it names. `whowas` asks for every entry the Ircd keeps, with no count.
- `quote` reads text with `parse`, under `Utf8Only`, and builds what it read again with `outbound`, so the Line sent reads back as the text did: its tags, command, and parameters, whatever spaces or colons the text used. Text with a CR, LF, or NUL is `InvalidParameter`, since the Line would end there. Text with no command, or with a source, which only an Ircd gives, is `Unparseable`. A tag a client may not send is `InvalidTag`, as for `outbound`. Which commands and tags a caller allows is the caller's to decide.

## `@iirc/protocol/isupport`

```ts
isupportTokens(params: readonly string[]): readonly IsupportToken[]   // Set { name, value } | Removed { name }
unescapeValue(value: string): string
prefixOf(value?): readonly Membership[] | undefined    // (ov)@+ when not sent, [] when empty, undefined when malformed
channelModesOf(value?): ChannelModes                   // { list, always, whenSet, flags }
chantypesOf(value?): string                            // #& when not sent
statusmsgOf(value?): string                            // "" (none) when not sent
modesOf(value?): number | undefined                    // 3 when not sent, undefined for no limit
limitOf(value?): number | undefined                    // NICKLEN, TOPICLEN, and the other lengths
limitsOf(value?): readonly Limit[]                     // CHANLIMIT and MAXLIST pairs
targetLimitsOf(value?): ReadonlyMap<string, number | undefined>   // TARGMAX
```

`prefixOf` reads `PREFIX` as its membership prefixes, most privileged first, and gives `undefined` for a value that is malformed: one not of the form `(modes)symbols`, one whose modes and symbols do not pair one to one, or one that repeats a mode or a symbol, such as `(oov)@%+`, since each names one rank and a repeat leaves the order unclear. A caller then uses `defaultPrefix`, `(ov)@+`, as the Client does, so a symbol only the malformed value named reads as a prefix that cannot be named.

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

- **Total.** Bytes that do not parse give `Unparseable`, and a Line that cannot be sent safely gives `Rejected`. The one thing that throws is a Schema's own `make`, such as `OutboundLine.make` or `CtcpText.make`, given an invalid value, as every Schema `make` does. Nothing else throws: `outbound`, the builders, and `encode` return `Rejected` for anything odd they are given, such as a boxed `String`, a field that is not an array, or a getter that throws.
- **Pure.** No clock, randomness, locale, time zone, environment, or I/O. Decoding uses the runtime's `TextDecoder` and nothing else from it. Comparing names uses no `toLowerCase` past ASCII and nothing locale-aware.
- **One guard on what leaves.** `encode` reads the Line once into plain data, checks every invariant below on what it read, and writes from that same read. So however a value typed as an `OutboundLine` was made, by a spread that replaced a checked field, a getter that changes between reads, or a cast, no unsafe byte leaves `encode`. Construction runs the same checks, through the same code, so errors come early, but `encode` is what guarantees safety. A `Rejected` from `encode` means code upstream built a Line it should not have: a programming error, which the Runtime reports rather than sends.
- **Safe by construction.** An `OutboundLine`'s command is upper-case letters or three digits, and it has at most 15 parameters. No parameter, as text or as bytes, holds NUL, CR, or LF, and a text parameter holds no lone surrogate. Only the last parameter may be empty, contain a space, or start with `:`. Tag values are different: they may hold CR, LF, a space, `;`, or `\`, because `encode` escapes each of them, and only NUL and lone surrogates are refused. Encoded, the command and parameters take at most 510 bytes, and 512 with the line ending, counted exactly as `encode` writes them, with the colon only when the last parameter needs it. The tag data, the bytes between the `@` and the space after the tags, takes at most 4094 bytes, as the `message-tags` spec allows a client. Its tags are client-only, or `label`, `batch`, and `draft/multiline-concat`.
- **Round trip.** Parsing an encoded `OutboundLine` gives back its command, its tags, and its text parameters, and `rawParams` gives back every parameter's bytes, including a `RawParam`'s exactly.
- **One place for Credentials.** `fillSecret` is the only code that puts a Credential's value into a Line. It splits the SASL `PLAIN` response into `AUTHENTICATE` Lines of 400 bytes of payload, and ends it with `AUTHENTICATE +` when the last is full, which is also the whole of an empty one. Its result is sent and never journaled. The Journal records the `SecretLine`, which holds only the name. A value that cannot be sent safely is `Rejected`: for `PASS` and a Channel key, a line break or NUL in the value, a key with a space or a comma, or a value too long to fit. SASL `PLAIN` is base64-encoded, so a line break in the password is carried safely, and only a NUL in the authzid, authcid, or password, which would break `PLAIN`'s own fields, or a lone surrogate, which UTF-8 cannot carry, is refused.
- **Where SASL goes next.** `SCRAM-SHA-256` would land in `SecretLine`: its replies depend on the Ircd's challenge, a nonce, and keys derived from the Credential, so it needs cases that take the challenge, or an exchange run on the Runtime's side. `EXTERNAL` needs no `SecretLine`, because its Credential is a client certificate that `Dial` would name.
- **Structure, not text.** Nothing here reads an Ircd's free text to decide anything. The text that ends a `005` is never read.

## Traps

- ISO-8859-1 is `windows-1252` in WHATWG, which maps bytes `0x80` to `0x9f` to other characters. The last resort, when the fallback cannot read the bytes, is real ISO-8859-1, where each byte is the code point of the same value.
- A `PONG` built from a parsed token's text re-encodes it as UTF-8, which changes a token that was not UTF-8. Build it from the token's `RawParam` from `rawParams` instead, which echoes its bytes exactly. Bytes given to `pong` are read into a `RawParam` at once.

## Tests

The ircdocs parser vectors are in `src/testdata/msg-split.yaml`, with formatting and CTCP vectors beside them in the same style. Every Line in `fixtures/transcripts/` must parse, or be built and read back the same. Tests read vectors and fixtures with Vite's `?raw` imports and Effect's YAML parser, so they need no file I/O.
