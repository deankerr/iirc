# @iirc/outbox

One Connection's queue of Lines waiting to leave: which goes next, and when. It is pure. It holds plain data, reads no clock, and depends on no other package of ours, so time arrives as an argument and the caller does the waiting. The Runtime keeps one Outbox for each Connection it holds, and its pump carries the Lines out.

This README is the module's written interface. The types are in `src/outbox.ts`. Priority stays out of the Client, and pacing is one safe default for every Ircd.

```ts
makeOutbox<A>({ pacing?, capacity?, firstCapacity? }): Outbox<A>  // empty, with a full bucket
offer(outbox, item: A, command: string): Offered<A>        // Queued { outbox } | Full
take(outbox, now: number): Take<A>                         // Taken { item, outbox } | Wait { until, outbox } | Empty { outbox }
spend(outbox, now): Spent { outbox } | Wait { until, outbox }    // a token for a Line not queued
takeAll(outbox): { items: readonly A[], outbox }           // in the order they would have left
nextAt(outbox, now): number | undefined                    // when the next Line may leave, for inspection
depth(outbox): number
goesFirst(command): boolean                                // PING and PONG
Pacing = { burst: number, interval: number }               // a Schema; interval in milliseconds
defaultPacing = { burst: 5, interval: 2000 }
defaultCapacity = 1000                                     // ordinary Lines
defaultFirstCapacity = 64                                  // PING and PONG
alwaysAdmitted(command): boolean                           // QUIT
```

The Outbox is generic over what it queues, so the Runtime queues its `Send` and `SendSecret` outputs whole, and a test queues anything. It asks for the Line's command when a Line is offered, and decides nothing else from the Line.

## Guarantees

- **FIFO, with `PING` and `PONG` first.** Every Line leaves in the order it was offered, so a `PRIVMSG` never overtakes the `JOIN` it depends on, nor falls behind a later `PART`. Only `PING` and `PONG` go ahead of the Lines waiting, in their own order among themselves, so a keepalive never waits behind a burst. They still take a token. Which Lines go first is decided from the command alone, which is structure, never from text.
- **A token bucket.** Up to `burst` Lines may leave at once, then one every `interval`. In any window of time, at most `burst` plus one for each whole `interval` in it leave. The bucket refills while nothing is sent, up to `burst` and no more.
- **One safe default.** `defaultPacing` is a burst of 5, then one Line every 2 s, as RFC 1459 §8.10 describes an Ircd's own limit, and as irssi and WeeChat pace. It is tuned for no Ircd, and a caller may pass another `Pacing`.
- **No fractions.** The bucket is held as `fullAt`, the time it is next full, so there is no part of a token to round.
- **A clock set back stalls nothing for long.** With a clock that moves only forward, `fullAt` is never more than a whole bucket ahead of now. Seen further ahead, the clock was set back, and the bucket is taken as empty as of now, so the next Line waits at most one `interval`, however far the clock moved. `take` stores what it saw in the Outbox it returns, so a `take` at the time a `Wait` names, with the Outbox that `Wait` gave, takes a Line, unless the clock was set back again in between.
- **Bounded, with room kept for what must leave.** At most `capacity` ordinary Lines wait, 1,000 by default. `PING` and `PONG` have a bound of their own, `firstCapacity`, 64 by default, so a full queue of ordinary Lines never refuses a keepalive, and a hostile flood of `PING`s cannot grow memory: past that bound a keepalive is refused rather than evicting an ordinary Line. A `QUIT` is always admitted, past `capacity`, since it is the last Line and leaving is what was asked. A refused offer is `Full`, nothing is queued, and nothing waits for room, so a caller never blocks on it.
- **One token for each wire Line.** An item taken may become several Lines on the wire, such as a SASL response filled to several `AUTHENTICATE` Lines. The caller spends a token for each Line after the first with `spend`, which waits as `take` does, so those Lines are paced like any others.
- **Plain data.** An `Outbox` holds numbers, arrays, and plain objects, and every function returns a new one, leaving the one it was given as it was. What is queued is the caller's.

## How the Runtime uses it

Its pump calls `take` with the time from Effect's `Clock`: a `Taken` Line is sent, a `Wait` is slept until, and on `Empty` it waits for an offer. When a Connection ends, `takeAll` gives back what never left, in order, and the Runtime steps it as `Unsent`. [The Runtime's README](../runtime/README.md) has the rest.

## Not yet

- **Expiry.** A Line waits until it leaves or its Connection ends, however long that is. A Line that stops being worth sending after a while, such as a lag `PING` or a reply to a Lookup, could carry an expiry and be dropped at the head of the queue without spending a token.
- **Pacing per Network.** Every Connection gets the same `Pacing`, which the Daemon may set for all. An Ircd that advertises its own limits, as ngircd's `PENALTY` hints, could be paced by them, and a Network could carry its own setting.
- **Cost per Line.** Every Line costs one token. Some Ircds charge more for some commands, or by length.
