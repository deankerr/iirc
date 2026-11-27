# @iirc/link-fetch-bun

The guard: an adapter of the link fetch port on Bun's own `fetch`, which connects only to an address it checked. It provides `LinkFetch` given iirc's version.

```ts
import { layerBunLinkFetch, makeBunLinkFetch, sniff, sniffed, systemResolver } from "@iirc/link-fetch-bun";

layerBunLinkFetch({ version, policy?, resolver?, trust? }): Layer<LinkFetch>
makeBunLinkFetch({ version, policy?, resolver?, trust? }): Effect<LinkFetchService>   // with its own pacer
sniff(leading): string | undefined   // the image type at least `sniffed` (1024) leading bytes show

Resolver: { resolve(name): Effect<readonly string[], LinkUnreachable> }   // every A and AAAA
```

Production gives the version alone, so it fetches under the fixed policy, resolves with `systemResolver`, which is `Bun.dns.lookup`, and trusts the system's roots. A test gives the loopback policy, a resolver it scripts, and its own certificate to `trust`, never turning verification off.

## How a link is fetched

- **Each hop resolves once, and connects to what it checked.** The name is resolved through the resolver, every record is checked by the policy, and the fetch names the checked address in its URL, IPv4 first, with `Host` and `tls.serverName` naming the link's own name. So SNI and the certificate are checked against the name, while the TCP peer is the address. It never fetches by name, so neither a name that answers differently the second time nor Bun's own DNS cache decides where a connection goes.
- **Each hop waits its turn with the guard's pacer,** in the place the fetch was given as it was asked, by its precedence, after the link is parsed and before its name is resolved. Each waits for a place at the name it is made to, and the first starts as it takes its place, so the minute counts a fetch only once it holds a place to go. A redirect gives up its place once it is read, and the last hop holds its place until its connection closes, which it does as soon as its body ends. The ten seconds run only while no hop is waiting.
- **Redirects are followed by hand,** at most three. Each `Location` is resolved against the link that redirected, by name, then parsed, checked, and pinned as a new link. A fourth is refused, and a redirect's body is never read.
- **`proxy: false` always,** so `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` are ignored.
- **Each hop is asked as the site table says,** redirect targets included. A rewrite replaces the hop's link before its turn is asked, so it waits by the name it goes to, and is parsed, resolved, and checked as any link. It is no redirect and counts toward none.
- **What is sent:** `User-Agent: iirc/<version> (+https://github.com/deankerr/iirc) bot`, or where the table says `crawler`, `Mozilla/5.0 (compatible; iirc/<version>; +https://github.com/deankerr/iirc) facebookexternalhit/1.1 Twitterbot/1.0`. An `Accept` for the purpose, or where the table says `media`, images, video, and sound only. `Accept-Language: en, *;q=0.5`, and never a cookie or a `Referer`. A stream asks for its bytes as the host keeps them, with one `Range` when it has one, and a `206` is answered as it came.
- **The body is read as a stream and never whole.** Bun decompresses it, and the bounds count what it gives. A page's head is scanned for its end and for an attribute value starting `og:` or `twitter:` in a tag, never in a comment or a script, and the scan stops once a head without one has ended. An image's first KiB is read before it is answered, to match it to its header: a magic number, or for an SVG a root `<svg` element after any XML declaration, comments, and DOCTYPE. A declared length over the bound, of bytes not compressed, is refused before any byte is read, except a stream's, which is cut off at its bound as it streams.

## Failure

A failure is told from the error's code, never its wording. A name that resolves to nothing, a refused or broken connection, and a certificate that does not name the link's name are `LinkUnreachable`. Anything that fails once the time is up is `LinkTimedOut`.

## Tests

`bun run test` runs the adversarial suite against servers on loopback ports the kernel picks, with the loopback policy and a scripted resolver. Waiting out the real 10 seconds takes `bun run e2e`, at the root or in this package, which runs `src/e2e/`.

## Not yet

- **Trying another checked address** when the first does not answer. A name is fetched at one address, IPv4 first.
