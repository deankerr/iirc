# @iirc/runtime

The Runtime drives one Client per Network. It journals each input, steps the Client, journals the outputs, and carries them out through its ports. This package holds the Runtime and the ports it drives through.

The in-memory adapters and the laws are in `src/testing/`.

## The Runtime

```ts
layerRuntime(client, options?): Layer<Runtime, DecodersMissing | JournalFailed, Journal | Transport | Vault>
RuntimeOptions = { pacing?, outboxCapacity?, hangupDrain?, stopTimeout?, lookTimeout?, spared? }

configure(network, configuration, ifSequence?): Effect<Sequence, NetworkStopped | ConfigurationChanged | TimelinesKept>  // the first one adds the Network
remove(network, { keep, life? }): Effect<{ sequence, life }, UnknownNetwork | LifeChanged | NetworkStopped | JournalFailed | VaultFailed>
kept: Effect<ReadonlyMap<NetworkId, Life>>                                // removed Networks whose Timelines are kept
configuration(network): Effect<InForce { configuration, sequence }, UnknownNetwork>
say(network, { kind, target, text, intent?, answers? }): Effect<Said { intent, sequence } | Refused { intent, sequence, reason }, UnknownNetwork | NetworkStopped>
act(network, { action, intent? }): Effect<Acted { intent, sequence } | Refused { intent, sequence, reason }, UnknownNetwork | NetworkStopped>
said(network, intent): Effect<Option<Sequence>, JournalFailed>          // was a Say or an Act under this intent journaled?
look(network, { lookup, intent? }): Effect<LookedUp { intent, sequence, result } | Pending { intent, sequence }, UnknownNetwork | NetworkStopped>
looked(network, intent): Effect<Option<LookedUp | Pending>, JournalFailed>   // a Lookup's result, folded from the Journal
read(network, { target, read }): Effect<Sequence, UnknownNetwork | NetworkStopped>   // target a Target, a Resolved, or null for the Network's own
close(network, target): Effect<Closed { sequence } | Refused { sequence, reason: Joined { channel } | NoTimeline }, UnknownNetwork | NetworkStopped>
retry(network): Effect<Sequence, UnknownNetwork | NetworkStopped>
known(network): Effect<{ knowledge, life }, UnknownNetwork>
channel(network, name): Effect<Option<ChannelView>, UnknownNetwork>    // one Channel, by name, folded as the Connection folds
inspect(network): Effect<NetworkInspection, UnknownNetwork>             // { status, client, connections: [{ connection, queued, nextAt }], timers }
networks: Effect<ReadonlyMap<NetworkId, NetworkStatus>>                 // Running | Stopped { reason }
lives: Effect<ReadonlyMap<NetworkId, Live { status, life } | Kept { life }>>  // every one held, live or kept, read together
news({ after? }): Stream<Happened, JournalFailed>                        // { network, life, sequence, at, news }, never ends
happenings({ after? }): Stream<Stepped { happened } | Changed { sequence, change }, JournalFailed>  // News and Changes, in Journal order
```

`Runtime` is an Effect service, imported from `@iirc/runtime`. `layerRuntime` takes the Client to drive, `client` from `@iirc/client` in the Daemon, and needs the Transport, the Journal, and the Vault. It reads time from Effect's `Clock`, and names intents and makes SASL nonces with Effect's `Random`, which the Daemon backs with a secure source. Closing the Layer's Scope is shutdown.

| Option | Default | What it sets |
| --- | --- | --- |
| `pacing` | a burst of 5, then one Line every 2 s | How fast Lines may leave each Connection, as `@iirc/outbox`'s `Pacing` |
| `outboxCapacity` | 1,000 | How many ordinary Lines may wait for one Connection |
| `hangupDrain` | 5 s | How long a `Hangup` lets queued Lines leave at pace before it hangs up anyway |
| `stopTimeout` | 5 s | How long shutdown, or a removal, waits for each Network's Connections to close |
| `lookTimeout` | 35 s | How long a `look` waits for its result once its `Look` is stepped |
| `spared` | none | The Credentials named outside the Networks, such as by the Owner's options, which a removal never forgets, as a function that runs a removal's decision while no other is named |

### Owner inputs

- **An Owner input answers once it is stepped.** `configure`, `say`, `act`, `look`, `read`, `close`, and `retry` give the Input's sequence once it is journaled, stepped, and its outputs carried out.
- **A `say` or an `act` answers with what its own step knew.** It is `Refused` when the Client refused it in that step, and `Said` or `Acted` otherwise. A `say` is refused as `Offline` or `Unsendable`, and an `act` as those or, for a ban by account, `AccountUnknown` or `NoAccount`.
- **A refusal that comes later, `Unsent` or `Rejected`, is News of a later step.**
- **A `say` names its intent,** given or chosen, and journals its `answers` with the `Say`, so its `Refused`, `Message`, and `Confirmed` News can be matched to it.
- **A `read` or a `close` names a Timeline by a Target, or as a projection holds it,** a `Resolved` from `@iirc/client`, which is journaled as given, for the Client to take without parsing.
- **A `close` answers with what its step decided.** It is `Closed` when the step reported `TimelineClosed`, `Refused` with `Joined`, naming the Channel, when Self was in it, and `Refused` with `NoTimeline` when its Target names no one Timeline, or it names the Network's own.
- **A stopped Network fails what waits on it.** A Network that has stopped fails its Owner inputs with `NetworkStopped`, at once or as it stops, so none waits forever.
- **Closing the Runtime stops every Network** with the reason `The Runtime closed`, and fails every call made after, a `configure` that would add a Network included.

### Configuration

- **`configuration` gives the Configuration in force,** the last `Configured` stepped, with its sequence, folded from the Journal, so it survives a restart. A Network never configured is `UnknownNetwork`.
- **A `configure` with `ifSequence` passes only if it was made from the Configuration in force.** `ifSequence` is the sequence the caller read, or `0` to add a Network. Otherwise it is `ConfigurationChanged`, with the sequence in force or `null`, nothing is journaled, and no Network is added. Two `configure`s made from the same Configuration never both pass.
- **Without `ifSequence`, the last `configure` wins.**
- **A `configure` runs to its end once admitted,** even if its caller goes away.

### Removing a Network

- **`remove` ends the Network.** It journals a `Removed`, which the Client steps by saying `QUIT` and hanging up, and waits within `stopTimeout` for its Connections to close. The Network then stops and is `UnknownNetwork` to every call that acts on it or reads its Client.
- **A stopped Network can still be removed.** One stopped by a failure, or by its Client's bug on replay, has its `Removed` journaled with no driver to step it, unless the Journal already holds it.
- **A removal that names `life` removes only that life.** It is checked in the turn that removes, and is otherwise `LifeChanged`, with the life held now.
- **A removal runs to its end once admitted,** even if its caller goes away, and no `configure` takes the id meanwhile.
- **A removal forgets the Credentials its Network named,** those the Configuration in force when the `Removed` was stepped names, but those another Network still names and those `spared` gives. A `Forgotten` record follows once the Vault has let go of them.
- **A removal cut short is finished on the next start.** One whose `Forgotten` was never journaled, by a crash or a failed Vault, is found by the next start's fold and finished then, sparing what a Network or `spared` then names.
- **Credentials are forgotten once.** After a `Forgotten` is journaled, nothing of that removal is forgotten again, so a name held later for another use is left alone.
- **Kept Timelines hold the id.** With `keep`, `kept` lists the id, `configure` refuses it with `TimelinesKept`, and removing it again journals another `Removed`, with no driver to step it, which drops them and frees the id. Without `keep`, the id is free at once.

### Lives

- **Each life of a Network has an identity.** A `Life` is the sequence of the `Configured` that began it, the first after the Network was added or after a `Removed`. It is folded from the Journal, so a restart gives the same, and it only increases for an id.
- **Every answer about a Network names its life.** `lives`, `known`, `kept`, a removal's answer, and every `Happened` name it.
- **A Network not yet configured has no life.** One added whose first `Configured` is not yet stepped is left out of `lives` and `known`. `remove` of a Network with no life is `UnknownNetwork`, journaling nothing, or `LifeChanged` with `null` when it names a `life`.

### Recovering after `NetworkStopped`

- **`NetworkStopped` does not mean the input was refused.** The Network may have stopped after the Input was appended and before the caller heard back. The Input is then in the Journal, a restart folds it, and its outputs may or may not have been carried out, so a `say` may or may not have been sent.
- **A restart never carries out a past step's outputs again.**
- **`configure`, `read`, `close`, and `retry` can be given again freely.** A `Configured` is the whole Configuration, a Read Marker only moves forward, a Timeline closed again stays closed, and a second `Retry` changes nothing a first did not.
- **A `say` or an `act` is recovered by its intent.** A caller that must not say a Message twice names the intent itself, and on `NetworkStopped` asks `said(network, intent)`, on this Runtime or the one started after it.
- **Once `NetworkStopped` is seen, `said` is settled.** An append is whole or absent, and the Network stops only after its driver has ended. `said` reads the Network's Inputs once, to the Journal's end, and ends.
- **`said` answering `Some(sequence)` means it must not be said again.** The `Say` was journaled and is stepped on every restart, though its Line may not have reached the Ircd. `None` means it was never journaled, and saying it again under the same intent is safe.
- **Intents correlate, they do not deduplicate.** A caller-chosen intent must be unique for its Network across the whole Journal, calls in flight included. The Runtime journals and steps two `Say`s under one intent as two, and `said` and the News cannot tell them apart.

### Lookups

- **A `look` answers with its result.** It journals a `Look` and, once it is stepped, waits for its result for at most `lookTimeout`. The result may be the Client's refusal in the `Look`'s own step: `Offline`, `Unsendable`, `Busy`, or `NotOffered`.
- **A `look` with no result in time is `Pending`,** as is one whose Network stopped first. The Client gives every Lookup a result within its own bound, or when its Connection ends, so a `Pending` is answered later.
- **`looked` finds a Lookup's result by its intent,** folded from the Journal as it stood: `LookedUp` once a step reported it, `Pending` while none has, and `None` when no `Look` under the intent was journaled. It answers the same on this Runtime or one started after it, where the `Started` that ends the Connection the Client believed open reports the Lookups it held.

### Reading the Client

- **`known`, `channel`, and `inspect` read the Client as it is now.**
- **`channel` reads one Channel,** found by its name folded with the Connection's casemapping, or `None` when the Client holds no such Channel. It costs what that Channel holds, where `known` builds everything the Network knows.
- **`inspect` adds what the Runtime holds:** whether the Network is running, the Connections it holds a Link for, each with how many Lines wait in its Outbox and when the next may leave, and its timers, projected with `timers` from every step.

### News

- **News is derived from the Journal.** `news` folds each Network's Inputs from `initial`, passing over every `Change`, and gives each step's News with its Network, its life, the sequence of its Input, and its `at`, for steps after `after`, and then live.
- **`happenings` gives the same steps with every Change in its place,** each Change with its sequence, so a reader that folds both, as the Timelines projection does, folds them in the order they were journaled.
- **A reader that resumes after the last sequence it has misses nothing,** and sees exactly what the Runtime's own fold saw.
- **A removed Network's last News is its `NetworkRemoved`.** The Inputs that trail its `Removed`, such as its Connection's `Closed`, give none, and another `Removed` gives its own.

### Driving a Network

Each Network has one fiber, which takes its inputs one at a time from one bounded queue: Owner inputs, Transport events, timer firings, and what each Connection's pump reports. A full queue holds back whoever offers. For each input, in order:

1. Give it its `at`, from the Clock, sampled when processing of the input begins.
2. Append the `Input`.
3. Step the Client.
4. Append its `Outputs` with `of` set to the Input's sequence. A step with no outputs appends none.
5. Carry out the outputs, in order.
6. Step the Lines an Outbox refused as full as an `Unsent`, one for each Connection, the same way.

- **The sequence alone orders the Journal.** Networks run side by side and a Clock may move backwards, so `at` is not ordered by sequence. A Timeline orders by `at` within its Network.
- **An Ircd reaches only its own Network.** Its bytes go to its own Client through its own queue.

Carrying out each output:

| Output | What the Runtime does |
| --- | --- |
| `Dial` | When it names a `certificate`, `reveal`s that Credential and parses it as PEM, a certificate chain and one private key. It opens a Scope for the Connection, `dial`s in it with the certificate if there is one, and starts its Outbox and pump there. Its events become `Opened`, `Received`, and `Closed` inputs with that Connection's id. Before a `Closed` is stepped, whatever is still queued or cut off is stepped as one `Unsent`. Once the `Closed` is stepped, the Scope is closed. |
| `Send` | Queues the Line in its Connection's Outbox. At its turn, the pump `encode`s and sends it. A `Rejected` encoding is logged and nothing is sent. A Line for a Connection the Runtime holds no Link for is dropped. |
| `SendSecret` | Queues it the same way. At its turn, the pump `reveal`s the Credential, `fillSecret`s the Line, `encode`s each Line, and sends them. If any step fails, nothing is sent and an `Unfilled` input is stepped: `Missing` for `CredentialMissing`, `Unavailable` for `VaultFailed`, `Unsendable` when `fillSecret` or `encode` refuses. A `SCRAM-SHA-256` round is answered by the Connection's exchange instead, below. |
| `CheckScram` | Checks the Ircd's server-final message against the Connection's exchange, which ends with it, and steps `ScramChecked` at once, before any other input, so the Client knows before a `903` right behind it. A signature that differs, an error, or no exchange is not verified, and is logged as a warning. |
| `Hangup` | Lets the Lines queued before it leave at pace, for up to `hangupDrain`, then calls `hangup` on the Link. When the drain runs out, every Line still queued is dropped but a `QUIT`, which is sent at once, past the pacing. What was dropped is stepped as `Unsent`, exactly once and always before the `Closed` that follows. An empty Outbox hangs up at once. |
| `Wake` | Sets one timer per `TimerId`, replacing the earlier one, or cancels it for `null`. When it is due, `Fired { at, due, timer }` is queued. A firing that went stale while it waited is stepped all the same, and the Client ignores it. |

### Pacing

Each Connection has its own Outbox, from `@iirc/outbox`, and one pump fiber, both in that Connection's Scope. Every Connection is paced alike, by `pacing`.

- **Lines leave in the order the Client emitted them,** except that `PING` and `PONG` go ahead of the Lines waiting, and `WHO` goes behind them.
- **A pump is woken, not only timed.** It sleeps until the next token, or until a new Line or a `Hangup` wakes it, so a drain deadline is met even when the next token is far off.
- **A full Outbox refuses at once.** A Line it refuses is stepped as `Unsent` after the step that output it, and nothing waits for room.
- **A `QUIT` is always admitted, and `PING` and `PONG` have room of their own,** so neither is refused behind a full queue of ordinary Lines.
- **A Credential is revealed at its Line's turn,** not when it is queued.
- **Each Line a Credential fills spends a token,** so a SASL response of several `AUTHENTICATE` Lines leaves at pace.
- **A Credential's value is never logged or journaled.** The filled Lines stay with the pump until written, and never reach `Unsent` or the Journal. A `SendSecret` cut off part way is given back as the Output it was.
- **A Line that never leaves comes back as `Unsent`.** A `Send` counts as sent unless an `Unsent` says otherwise, and a Line the pump has taken counts as sent, even if the Connection ended as it was written.
- **The Outbox is never journaled.** A restart begins with none, since every Connection has ended.

### The SASL exchange

`SCRAM-SHA-256` (RFC 5802 and RFC 7677, with no channel binding) is worked out in `src/scram.ts`, in an exchange the Runtime holds for each Connection (ADR 0019).

- **The client-first message begins an exchange.** At its turn, the pump makes a 15-byte nonce from Effect's `Random` and keeps it with the Connection, replacing any exchange before it.
- **The client-final message answers only the exchange its nonce came from.** A server-first message that is not base64 of UTF-8, does not parse, names a mandatory extension, has a nonce that does not extend ours, or asks for more than 600,000 iterations is `Unanswerable`, and nothing is derived. Otherwise the pump SASLpreps the password, derives the salted password with PBKDF2 on WebCrypto, sends the proof, and keeps the server signature to check. A check that ended the exchange while it derived means the proof is never sent.
- **Nothing the exchange makes is journaled or logged:** the client messages with the nonce and the proof, and the salted password. The Journal records the Client's request, the `SecretLine` with the account, the Credential's name, and the Ircd's message it answers. The exchange keeps the nonce until the client-final message is made, then the server signature until the check, which ends it, and is dropped with the Connection.
- **What the Ircd sends is journaled whole, as every received Line is.** A login leaves the server-first message, holding the salt, the iteration count, and our nonce inside the Ircd's, and the server-final message, holding the server signature, in the Journal. Anyone who can read the Journal can test password guesses against them offline, as a passive listener who can read the IRC plaintext could, and ADR 0019 accepts this rather than redact received Lines.
- **A long message is split over `AUTHENTICATE` Lines** as `PLAIN`'s is, each spending a token.

### Restart

- **The Runtime refuses to start with `DecodersMissing`** unless `missingDecoders()` from `@iirc/protocol/line` is empty.
- **Each Network is refolded from its Inputs alone.** The Runtime reads every Entry once, passes over every `Change`, and folds each Network's Inputs from `initial`, keeping the state and the timer table `timers` projects. Journaled Outputs are never read back (ADR 0002).
- **A `Removed` ends a life.** A Network whose last life ended so is not started, and is `kept` when its last `Removed` kept its Timelines.
- **A `Configured` after a `Removed` begins a new Network** under the same id, from `initial`, so nothing of the removed one reaches it. Every fold of the Journal, News and `looked` included, keeps this rule.
- **Then each Network is driven again.** The Runtime sets every timer in the table, firing at once one already due, and appends and steps a `Started`.
- **The `Started` tells the Client its Connections are over.** A Connection still open when shutdown's bound ran out gets no `Closed`. A `Stopping` in the Journal shut the Client's gate, and the `Started` opens it again, so the Client dials as it would after any restart.

### Failure

- **A `JournalFailed` stops its Network.** The Runtime does not step an input it did not keep, or carry out outputs it did not keep. The Network's Connections are closed at once, with no `QUIT`, its timers stop, it reports `Stopped` with the reason, and the failure is logged. Other Networks carry on.
- **A stopped Network stays stopped until the Runtime starts again.**
- **A defect stops only its Network.** A Client that throws has a bug. On restart its refold stops at the same input, so it stays stopped with the state from before that input, and the other Networks start.

### Shutdown

- **Shutdown is graceful, within a bound.** Closing the Runtime, even from an interrupted fiber, refuses every new Network, then appends and steps a `Stopping` for each running Network at once, without first waiting on an Owner input already admitted. The Client answers it with a `QUIT` and a `Hangup`.
- **Each Network waits for every Connection's `Closed`, or for `stopTimeout`.** Meanwhile a `Hangup` drains for at most half of `stopTimeout`.
- **Inputs within the bound are stepped as usual,** but an Owner input queued after the `Stopping` is never stepped, and fails with `NetworkStopped`.
- **Then every Network's fiber stops, all at once.** Its pumps and timers stop and its Connections' Scopes close, which ends any Connection still open at once. Nothing that happens after is journaled.
- **`stopTimeout` bounds what waits on the Ircd and the Transport.** Shutdown still waits for a Journal append already in flight to settle, which the Journal port does not bound. Networks stop side by side.
- **Each Network reports `Stopped` with `The Runtime closed`,** which is not logged as an error. A Network already stopped by a failure gets no `Stopping`. A Connection cut off at the bound is logged as a warning.

### Logging

- **The Runtime logs through `Effect.log*` and builds no Logger.** The composition root builds it.
- **A Network's driver annotates its logs with the Network,** as does the log that it stopped on restart.
- **A Connection's life is logged at INFO:** `Dialling` with its Connection id and Ircd, `Connected as <nick>` when a Session starts, and `Connection closed` once for each Connection, as its `Closed` is stepped.
- **`Connection closed` says why.** It carries the `connection` id, the Ircd's `host`, `port`, and `tls`, the Transport's `reason`, and from that step's News, `ended`, the Client's own reason, and `session`, whether a Session had begun.

## Ports

Each port is an Effect service. An adapter provides it as a Layer, from its own package, which the Runtime never imports. The Runtime uses no platform service, such as `FileSystem`, `Config`, or a socket, and reads no wall clock. This package's tests run the real Client on the in-memory adapters, on a `TestClock`.

| Port | Its job | Imports | In-memory adapter |
| --- | --- | --- | --- |
| Transport | Dial an Ircd, carry Lines both ways, say how it ended | `@iirc/runtime/transport` | `makeMemoryTransport`, an in-memory pair |
| Journal | Append records durably, read them back, follow the tail | `@iirc/runtime/journal` | `makeMemoryJournal` |
| Vault | Hold Credentials, give a value at the last moment | `@iirc/runtime/vault` | `makeMemoryVault` |
| Clock | Tell the time, and wake at a time | `@iirc/runtime/clock` | `TestClock` from `effect/testing` |

## Transport

```ts
dial(address: IrcdAddress, certificate?: ClientCertificate): Effect<Link, never, Scope>
ClientCertificate = { credential: CredentialName, certificate: Redacted<string>, key: Redacted<string> }
Link = { events: Stream<LinkEvent>, send(bytes): Effect<void>, hangup: Effect<void> }
LinkEvent = Opened | Received { bytes } | Closed { reason: CloseReason }
```

- **It never fails.** A refused, unreachable, or timed-out dial, a TLS failure, a reset, and a stalled write all end as `Closed` with a reason.
- **Events come in order.** At most one `Opened`, then any number of `Received`, then exactly one `Closed`, and then the stream ends. A failed dial gives `Closed` with no `Opened`. Over TLS, `Opened` comes after the handshake. `events` is read once.
- **`Received` holds one Line's bytes without its line ending.** CRLF, a bare LF, and a bare CR each end a Line, and empty Lines are skipped.
- **A Line longer than `maxReceivedBytes` is cut,** to 8191 tag bytes plus 510, and the rest of it is dropped. An unfinished Line when the Connection ends is dropped.
- **A TLS dial given a `certificate` presents it in the handshake.** One the adapter cannot use is dialled without it, with a warning that names only the Credential. A plaintext dial ignores it.
- **It decodes nothing.** Bytes go to the Client as they came (ADR 0002).
- **`send` writes one Line's bytes,** line ending included. Before `Opened` or after `Closed`, it does nothing.
- **`hangup` ends the Connection** with `Closed` `HungUp`, unless it had already ended for another reason. It first lets what was already sent reach the Ircd, within a bound.
- **An interrupted `hangup` either ended the Connection or did nothing,** so another `hangup` still works.
- **Closing the Scope ends the Connection without a `Closed`.**
- **TLS is verified.** Certificates are checked, and SNI is sent for a host name. Falling back to plaintext is the Client's decision.
- **Socket timers are the Transport's.** Connecting, the TLS handshake, and a stalled write each end as `Closed` `TimedOut`. A TLS failure ends as `Closed` `Tls`, with no finer kind. Timers about Lines, such as silence, are the Client's.

## Journal

```ts
append(record: JournalRecord): Effect<Sequence, JournalFailed>
read({ after?, network? }): Stream<Entry, JournalFailed>    // up to the end as it stood
follow({ after?, network? }): Stream<Entry, JournalFailed>  // and then each new Entry
Entry = { sequence: Sequence, record: JournalRecord }
JournalRecord = Input { network, input } | Outputs { network, of, outputs } | Forgotten { network, credentials } | Change { change }
Change = UiSet | UiUnset | OptionSet | OptionUnset | Uploaded | Renamed | Deleted | TimelineRead | TimelineClosed
networkOf(record): NetworkId | undefined                 // none for a Change
```

- **One Journal for the Daemon.** Every Entry shares one sequence. An `Input`, `Outputs`, or `Forgotten` names its Network, and a `Change` belongs to none, though one that marks a Timeline names the Network the Timeline is one of.
- **The Journal knows nothing of which options exist.** It holds an option's Change by its name, with its value as JSON. The Daemon parses a value before it journals it, and folds the Changes.
- **A Timeline no Client can name is marked by a Change** (ADR 0018): `TimelineRead` or `TimelineClosed`, naming the Timeline's id and the Network it is one of, which no Client steps.
- **Reading by Network leaves out every Change.** `read` and `follow` with `network` give that Network's Entries alone, and without it, every Entry.
- **Appends are durable** before `append` returns, and are numbered in the order they complete. Sequences only increase, and may skip numbers.
- **An append is whole or absent, and settled when it returns.** One interrupted or failed is either kept, and read like any other, or never appears. An adapter whose write can go on after interruption makes the append uninterruptible, or waits for the write to settle. No law can check this, so each adapter says how it keeps it.
- **`read` and `follow` give each Entry once, in order.** `follow` gives the past and then each new Entry as it is appended, with no gap between them, and never ends.
- **Records are Schemas.** Every adapter stores their encoding, the in-memory one too, so a record that cannot be stored fails in tests.
- **A `SendSecret` is journaled with the Credential's name,** never its value.
- **An adapter refuses another version.** `journalVersion` is 1, and an adapter that finds another refuses to open with `JournalVersionMismatch`. Nothing is migrated.
- **`JournalFailed`** means the Journal could not be written or read.
- **Replay is exact on the Bun pinned in the root `package.json`.** Another runtime, or another version of Bun, may decode some fallback bytes differently.

## Vault

```ts
reveal(name): Effect<Redacted<string>, CredentialMissing | VaultFailed>
hold(name, value: Redacted<string>): Effect<void, VaultFailed>
forget(name): Effect<void, VaultFailed>
names: Effect<ReadonlySet<CredentialName>, VaultFailed>
```

- **Values are always `Redacted`.** The Runtime unwraps one only through `fillSecret` in `@iirc/protocol`, whose result is sent and never kept, through its SASL exchange, which keeps only the server signature it derived, and through `parseCertificate`, which reads a client certificate to find its blocks. The Transport adapter unwraps the certificate's values to hand them to TLS.
- **The Runtime reveals at the last moment,** for each `SendSecret` and for the certificate a `Dial` names, and lets go of the value once the Line is sent or the dial is made.
- **A client certificate that cannot be had is dialled without.** A Credential that is missing, a Vault that fails, and a value with no certificate or no single key each give a warning naming only the Credential and the reason, and the Connection dials without a certificate. The value is never journaled or logged.
- **A Credential that cannot be revealed sends nothing.** The Runtime steps an `Unfilled` input naming the `SecretLine` and the reason, so the Client decides what follows. It never holds the value or the refused Lines.
- **`VaultFailed` can come from any call,** whenever the Vault cannot be read.
- **`hold` replaces any earlier value, and `forget` of one not held does nothing.**
- **`names` lists names, never values.**

## Clock

```ts
now: Effect<Instant>
sleepUntil(at: Instant): Effect<void>
```

- **The Clock port is Effect's own `Clock`.** Its live adapter is the default Clock, and its test adapter is `TestClock`.
- **The Runtime reads time only through it.** Every input's `at` comes from `now`, and every timer waits with `sleepUntil`, so a test drives all of it with `TestClock.adjust`.

## The laws

`@iirc/runtime/testing` holds the laws every adapter of a port keeps, as data: `journalLaws`, `vaultLaws`, and `transportLaws`.

- **A law is an Effect that fails with `LawBroken`,** so the module needs no test runner.
- **`holds(law, make)` checks one law against a fresh harness,** in its own Scope, and fails after thirty seconds rather than hanging.
- **The Journal's laws cover Changes and concurrency.** A Change's value, any JSON, is read back exactly and left out of a Network's Entries. Appends for two Networks and Changes run concurrently, and appends are interrupted at every point between two operations.
- **The Transport's laws interrupt a hangup at every point,** and check that the Connection still ends once.
- **A Transport's harness includes the far end,** a `TestIrcd` that accepts each dial as a `TestCall`.
- **Production code may not import `@iirc/runtime/testing`.** `src/testing/harness.ts` is the Runtime's own test harness, and not part of the kit.

```ts
it.each(journalLaws)("$name", async (law) => {
  await Effect.runPromise(holds(law, temporaryFile.pipe(Effect.flatMap(makeSqliteJournal))));
});
```
