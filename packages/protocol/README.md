# @iirc/protocol

The IRC protocol as values: Lines in, Lines out, and the places a Credential can go. It is pure, and depends on no other package of ours.

This README is the module's written interface. The types are in `src/line.ts`. The functions below are the module's to build, from its brief, porting milestone 2's grammar, parser, builders, and conformance vectors on purpose (`git show m2:packages/protocol/src/line.ts`).

## Types

| Type | What it is |
| --- | --- |
| `Line` | One received Line, parsed: tags, source, command, and parameters. Anything that parses is a Line. |
| `Parsed` | A `Line`, or `Unparseable` with a reason. |
| `Encoding` | How bytes become text: `Utf8Only`, or UTF-8 or else a fallback encoding named by its WHATWG label. |
| `OutboundLine` | A Line that is safe to send. It cannot inject a second Line, and it fits. |
| `CredentialName` | The name of a Credential, which the Vault holds. |
| `SecretLine` | A Line with a Credential's name where its value goes: `Pass`, `AuthenticatePlain`, or `JoinWithKey`. |

`OutboundLine` and `SecretLine` are Schemas, because the Journal records them. Decoding a recorded `OutboundLine` checks it again.

## Functions to build

```ts
parse(bytes: Uint8Array, encoding: Encoding): Parsed
encode(line: OutboundLine): Uint8Array            // with CRLF
outbound(command: string, params: readonly string[]): OutboundLine | Rejected
// and builders for the Lines the Client sends: privmsg, notice, join, part, quit, cap, pong, ...
fillSecret(line: SecretLine, value: Redacted<string>): readonly OutboundLine[]
```

## Invariants

- **Total.** Nothing here throws. Bytes that do not parse give `Unparseable`, and a Line that cannot be sent safely gives `Rejected`.
- **Safe by construction.** An `OutboundLine` has no NUL, CR, or LF anywhere, and only its last parameter may be empty, contain a space, or start with `:`. Encoded, it fits in 512 bytes with its line ending, not counting tags. Its tags are client-only, or `label`, `batch`, and `draft/multiline-concat`, which `labeled-response` and `draft/multiline` need.
- **Round trip.** Parsing an encoded `OutboundLine` gives back its command and parameters.
- **One place for Credentials.** `fillSecret` is the only code that puts a Credential's value into a Line. It splits the SASL PLAIN response into 400-byte `AUTHENTICATE` chunks, which depend on the value. Its result is sent and never journaled. The Journal records the `SecretLine`, which holds only the name.
- **Where SASL goes next.** `SCRAM-SHA-256` would land in `SecretLine`: its replies depend on the Ircd's challenge, a nonce, and keys derived from the Credential, so it needs cases that take the challenge, or an exchange run on the Runtime's side. `EXTERNAL` needs no `SecretLine`, because its Credential is a client certificate that `Dial` would name.
- **Structure, not text.** Nothing here reads an Ircd's free text to decide anything.
