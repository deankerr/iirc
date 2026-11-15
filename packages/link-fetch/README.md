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
  | LinkTooLarge { limit } | LinkWrongType { type }

parseLink(policy, link, base?): Result<Target, LinkRefused>     // scheme, userinfo, port
admit(policy, port, addresses): Result<Address, LinkRefused>    // every record, or none
```

`LinkFetch` is an Effect service. An adapter provides it as a Layer from its own package.

## What it promises

- **A body is bounded for its purpose, after decompression.** A page ends cleanly at the end of its `</head>`, at its `<body`, or at 1 MiB. A raster image may be 8 MiB, an SVG 1 MiB, an oEmbed 64 KiB, and a stream 200 MiB; past that the body fails with `LinkTooLarge`. `limits` holds them.
- **A fetch is held to 10 seconds,** body and all, except a stream, which is held to 10 seconds to its first byte.
- **The type is the purpose's.** A page is `text/html` or `application/xhtml+xml`, an image is PNG, JPEG, GIF, WebP, AVIF, or SVG by its header and its leading bytes alike, an oEmbed is JSON, and a stream is `video/*` or `audio/*`. Anything else is `LinkWrongType`.
- **The connection lives in the Scope.** Closing it stops the fetch and its body, read or not, and a body that ends at a bound closes its connection.
- **`link` is the last link fetched, by name,** as the URL parser normalised it, after any redirects.

## The policy

A link is parsed by the WHATWG URL parser first, and what it produced is checked: `http:` or `https:` only, no userinfo, and a port the policy allows. Every address its name resolves to is then checked, and if any one is special, the whole name is refused. IPv4-mapped and IPv4-compatible IPv6 is unmapped first and checked as IPv4, and NAT64, 6to4, and Teredo are refused outright. An IP literal is checked the same way.

`fixedPolicy` is what production uses: ports 80 and 443, to public addresses only. Special means anything in the IANA special-purpose registries, AS112 and AMT included, and for IPv6 anything outside global unicast, `2000::/3`. No option widens it.

## Testing

`loopbackPolicy(port, address?)` is the fixed policy that also admits one loopback address, `127.0.0.1` unless given, on one port, where a test's server listens. `makeFakeLinkFetch(answers)` answers recorded responses or failures by link, as the parser normalises it, and records each fetch asked of it, in `asked`. A link with no answer is unreachable.

Production code may not import `@iirc/link-fetch/testing`.
