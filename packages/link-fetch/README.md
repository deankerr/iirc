# @iirc/link-fetch

The link fetch port: fetches a stranger's link for one purpose, and either answers a body already bounded for it, from a public address, or refuses with a typed reason. It also holds the address policy, as a pure value its adapters are built with.

The test policy and the fake adapter are exported from `@iirc/link-fetch/testing`.

```ts
import { LinkFetch, fixedPolicy, parseLink, admit } from "@iirc/link-fetch";

fetch(link, purpose): Effect<Fetched, LinkFetchFailure, Scope>
  purpose: { kind: "page" } | { kind: "image" } | { kind: "oembed" }
         | { kind: "stream", range?: { start, end? } }   // [start, end)
Fetched: { link, status, type, headers, body: Stream<Uint8Array, BodyFailure> }

LinkRefused { reason } | LinkUnreachable { reason } | LinkTimedOut
  | LinkTooLarge { limit } | LinkWrongType { link, type }

parseLink(policy, link, base?): Result<Target, LinkRefused>     // scheme, userinfo, port
admit(policy, port, addresses): Result<Address, LinkRefused>    // every record, or none

makePacer: Effect<Pacer>                                        // pacing: { perName: 2, perMinute: 30 }
Pacer: { start: Effect<void>, hop(name): Effect<void, never, Scope> }
```

`LinkFetch` is an Effect service. An adapter provides it as a Layer from its own package.

## What it promises

- **A body is bounded for its purpose, after decompression.** A page ends cleanly before its `<body`, after its `</head>`, or at 1 MiB, and a `<body>` in a comment, script, style, or title ends nothing. A raster image may be 8 MiB, an SVG 1 MiB, an oEmbed 64 KiB, and a stream 200 MiB. A stream's `416` is answered whatever its type. A body that passes its bound fails with `LinkTooLarge`, and so does one that reaches it without ending, unless its declared length says it is whole. `limits` holds them.
- **A fetch is held to 10 seconds,** body and all, except a stream, which is held to 10 seconds to its first byte.
- **The type is the purpose's.** A page is `text/html` or `application/xhtml+xml`, an image is PNG, JPEG, GIF, WebP, AVIF, or SVG by its header and its leading bytes alike, an oEmbed is JSON, and a stream is `video/*` or `audio/*`. Anything else is `LinkWrongType`, which names the `link` that answered, after any redirects.
- **The connection lives in the Scope.** Closing it stops the fetch and its body, read or not, and a body that ends at a bound closes its connection.
- **`link` is the last link fetched, by name,** as the URL parser normalised it, after any redirects.
- **Fetches wait their turn, and never fail for waiting.** Every adapter builds in a pacer of its own. At most two hops run at once to one name, each counted by the name it is made to and held until it is done, and at most 30 fetches start in any rolling minute, read through `Clock`. A fetch beyond either bound waits, in the order it asked, and its time limit does not run while it waits. Every purpose counts, a stream included.

## The policy

A link is parsed by the WHATWG URL parser first, and what it produced is checked: `http:` or `https:` only, no userinfo, and a port the policy allows. Every address its name resolves to is then checked, and if any one is special, the whole name is refused. IPv4-mapped and IPv4-compatible IPv6 is unmapped first and checked as IPv4, and NAT64, 6to4, and Teredo are refused outright. An IP literal is checked the same way.

`fixedPolicy` is what production uses: ports 80 and 443, to public addresses only. Special means anything in the IANA special-purpose registries, AS112 and AMT included, and for IPv6 anything outside global unicast, `2000::/3`. No option widens it.

## Testing

`loopbackPolicy(port, address?)` is the fixed policy that also admits one loopback address, `127.0.0.1` unless given, on one port, where a test's server listens. `makeFakeLinkFetch(answers, { held? })` answers recorded responses or failures by link, as the parser normalises it, and records each fetch in `asked` once the pacer gives it its turn, as one hop to the name of the link asked, held until the caller's Scope closes. A `held` link's fetch is made but answers nothing until `release(link)`. A link with no answer is unreachable. A recorded response is answered as the guard would for the purpose, by its declared type alone: a type the purpose does not take is `LinkWrongType`, a page is cut at its bound, and any other body over its bound gives its bytes up to the bound and then fails with `LinkTooLarge` as it is read. A response may be `zeros: n` in place of a body, which makes its bytes as they are read. A stream of a response with no status recorded is answered as a host serving ranges would: a range is `206` with `Content-Range` and `Content-Length`, one starting at or past the end is `416` with `Content-Range: bytes */total`, and a recorded status is answered as recorded, whole.

Production code may not import `@iirc/link-fetch/testing`.
