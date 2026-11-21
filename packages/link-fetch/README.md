# @iirc/link-fetch

The link fetch port: fetches a stranger's link for one purpose, and either answers a body already bounded for it, from a public address, or refuses with a typed reason. It also holds the address policy, as a pure value its adapters are built with.

The test policy and the fake adapter are exported from `@iirc/link-fetch/testing`.

```ts
import { LinkFetch, fixedPolicy, parseLink, admit } from "@iirc/link-fetch";

fetch(link, purpose, precedence?): Effect<Fetched, LinkFetchFailure, Scope>
  precedence: "begun" | "first" | "refresh"                     // "first" unless given
  purpose: { kind: "page" } | { kind: "image" } | { kind: "oembed" }
         | { kind: "stream", range?: { start, end? } }   // [start, end)
Fetched: { link, status, type, length, headers, body: Stream<Uint8Array, BodyFailure> }

LinkRefused { reason } | LinkUnreachable { reason } | LinkTimedOut
  | LinkTooLarge { limit } | LinkWrongType { link, type, length }

parseLink(policy, link, base?): Result<Target, LinkRefused>     // scheme, userinfo, port
admit(policy, port, addresses): Result<Address, LinkRefused>    // every record, or none

makePacer: Effect<Pacer>                                        // pacing: { perName: 2, perMinute: 30 }
Pacer: Turn & { ask(precedence): Effect<Turn> }                 // alone, a first fetch asked now
Turn: { start: Effect<void>, hop(name): Effect<void, never, Scope>,
        begin(name): Effect<void, never, Scope> }              // start and a name's place at once
```

`LinkFetch` is an Effect service. An adapter provides it as a Layer from its own package.

## What it promises

- **A body is bounded for its purpose, after decompression.** A page of HTML ends cleanly before its `<body`, after its `</head>`, or at 1 MiB, and a `<body>` in a comment, script, style, or title ends nothing. A page of plain text ends cleanly at 16 KiB, with no scan for a head, since it is no HTML. A raster image may be 8 MiB, an SVG 1 MiB, an oEmbed 64 KiB, and a stream 200 MiB. A stream's `416` is answered whatever its type. A body that passes its bound fails with `LinkTooLarge`, and so does one that reaches it without ending, unless its declared length says it is whole. `limits` holds them.
- **A fetch is held to 10 seconds,** body and all, except a stream, which is held to 10 seconds to its first byte.
- **The type is the purpose's.** A page is `text/html`, `application/xhtml+xml`, or `text/plain`, an image is PNG, JPEG, GIF, WebP, AVIF, or SVG by its header and its leading bytes alike, an oEmbed is JSON, and a stream is `video/*` or `audio/*`. Anything else is `LinkWrongType`, which names the `link` that answered, after any redirects, and is raised before any byte of the body is read.
- **The length is what the host declared of the bytes the body gives.** `Fetched` and `LinkWrongType` carry it as `length`: the `Content-Length`, in bytes, unless the body is encoded, and null when none is declared. It is the length of the whole body, never of the bytes a bound lets through.
- **An error is its status alone.** An answer whose status, after any redirects, is outside 200 to 299 is answered with that status, its type unchecked, and an empty body, and no byte of its body is read. A stream is the exception: its answer is checked and read as any other.
- **The connection lives in the Scope.** Closing it stops the fetch and its body, read or not, and a body that ends at a bound closes its connection.
- **`link` is the last link fetched, by name,** as the URL parser normalised it, after any redirects.
- **Fetches wait their turn, and never fail for waiting.** Every adapter builds in a pacer of its own. At most two hops run at once to one name, each counted by the name it is made to and held until it is done, and at most 30 fetches start in any rolling minute, read through `Clock`. A fetch beyond either bound waits, and its time limit does not run while it waits. Every purpose counts, a stream included.
- **Of the fetches waiting, the one standing furthest ahead goes next.** A fetch's precedence comes first: `begun`, which finishes what a fetch already made began, such as a page's oEmbed or image, then `first`, a link never fetched before, then `refresh`, one fetched again. Among equals, the one asked last goes first. A fetch keeps its place through every hop it makes. Its first hop starts and takes a name's place at once, once both bounds allow it, so a fetch is counted as started only as it goes, and one waiting for the minute never holds a name. A waiting fetch the bounds would not let go never holds back one they would. Precedence orders the waiting and never changes a bound, and a fetch that stops waiting is forgotten at once.

## The policy

A link is parsed by the WHATWG URL parser first, and what it produced is checked: `http:` or `https:` only, no userinfo, and a port the policy allows. Every address its name resolves to is then checked, and if any one is special, the whole name is refused. IPv4-mapped and IPv4-compatible IPv6 is unmapped first and checked as IPv4, and NAT64, 6to4, and Teredo are refused outright. An IP literal is checked the same way.

`fixedPolicy` is what production uses: ports 80 and 443, to public addresses only. Special means anything in the IANA special-purpose registries, AS112 and AMT included, and for IPv6 anything outside global unicast, `2000::/3`. No option widens it.

## Testing

`loopbackPolicy(port, address?)` is the fixed policy that also admits one loopback address, `127.0.0.1` unless given, on one port, where a test's server listens. `makeFakeLinkFetch(answers, { held? })` answers recorded responses or failures by link, as the parser normalises it, and records each fetch in `asked`, with its precedence, once the pacer gives it its turn, as a first hop to the name of the link asked, held until the caller's Scope closes. A `held` link's fetch is made but answers nothing until `release(link)`. A link with no answer is unreachable. A recorded response is answered as the guard would for the purpose, by its declared type alone: a status outside 200 to 299 but a stream's is answered with no body, a type the purpose does not take is `LinkWrongType`, a page is cut at its bound, plain text at its own, its `length` is the `Content-Length` it was recorded with, unless it is encoded, and any other body over its bound gives its bytes up to the bound and then fails with `LinkTooLarge` as it is read. A response may be `zeros: n` in place of a body, which makes its bytes as they are read. A stream of a response with no status recorded is answered as a host serving ranges would: a range is `206` with `Content-Range` and `Content-Length`, one starting at or past the end is `416` with `Content-Range: bytes */total`, and a recorded status is answered as recorded, whole.

Production code may not import `@iirc/link-fetch/testing`.
