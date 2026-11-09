# The Client and Feature interfaces

Step 1 of [the proposal's plan](2026-11-07-architecture-proposal.md#11-getting-started) asked for the Client and Feature interfaces to be designed twice. Three designers each made a radically different interface from the same brief. This note records what they made, how they compared, and what we chose. The interface itself is written in [`packages/client/README.md`](../../packages/client/README.md) and [`packages/protocol/README.md`](../../packages/protocol/README.md), and typed in their `src/`.

## The three designs

- **A: the smallest interface.**
  - The Client exports `initial`, `step`, and `view`.
  - Configuration arrives whole as an input, and the Client works out what changed.
  - One output, `Wake { timer, at | null }`, starts and cancels a timer.
  - A Feature is one fold over a stream of Signals that runs both ways. The RFC floor is a Feature that is always on.
  - Strength: tests need only `step` and `view`. A Feature that works both ways, such as SASL, keeps its state in one place.
  - Weakness: every Feature author learns which way each Signal goes, and every Feature handles `CAP DEL` by hand.
- **B: the most room for extension.**
  - A kernel that knows no IRC, and Features that meet only over five typed wires: Annotations, Facts, Policies, Intents, and Slots.
  - `CAP DEL` needs no code in any Feature, because the kernel marks a Feature's facts stale.
  - Four generic laws test every combination of Features.
  - Weakness: it builds the plugin system that the vision puts under "Not now". It also loses the statechart, and it rejects a Journal written by a different set of Features.
- **C: the simplest for the commonest callers.**
  - A scenario is an IRC transcript, in the same format an end-to-end recorder writes. Every scenario replays its Journal and checks that the result is the same.
  - Views read `Knowledge`, where every fact is a `Fact<T>` with four cases and no mention of a cap.
  - `step` also returns News, which is derived and never journaled.
  - A Feature is a record of hooks, one per ingress stage, with a `keeps` list so that `CAP DEL` is handled once.
  - Weakness: the Feature seam is wide, strict transcripts break when the Lines we send change, and the transcript format needs its own parser.

All three reached these independently, which suggests the substrate is close:

- `Received` carries bytes, not a parsed Line, so a parser fix repairs history on replay (ADR 0002).
- The Client numbers Connections, so input from an old Connection is recognisably stale.
- A Credential travels as a name, and `@iirc/protocol` fills it in on the Runtime's side.
- Facts carry where they came from, and can go stale.
- `step` never throws. Hostile input is recorded and changes nothing.

## How they compared

- **Depth.** A has the deepest interface for its callers. B's Client is small too, but it pushes a wide interface onto Feature authors. C spends interface on purpose, where it is used most.
- **Locality.** A keeps a Feature's two directions together, but repeats `CAP DEL` handling in every Feature. B handles `CAP DEL` once, but finding why a fact is true means following wires across Features. C handles `CAP DEL` once through `keeps`, and its stages make ingress order explicit.
- **Seam placement.** A and C keep the Feature seam inside the Client and test it only through `step`. That is right while there is no plugin system. B makes the Feature seam the external interface.

## What we chose

A hybrid, mostly from C.

- **The Client** is `initial`, `step(state, input) → { state, outputs, news }`, `known(state)`, and `inspect(state)`. `Client<State>` is generic, so the Runtime works with the real Client and with a scripted one.
- **From A:**
  - `initial` is a constant, and Configuration arrives whole on a `Configured` input. Joining and parting are changes of Configuration, so there are no `Join`, `Part`, or `Leave` inputs.
  - Timers are one `Wake` output.
  - The order of Features is one registry array in one file.
- **From C:**
  - A `Started` input, so the Client itself ends a Connection it believed open.
  - `SendSecret` with a closed list of secret Lines.
  - `Fact<T>`, News, `inspect`, and the stage hooks with `keeps`.
  - The transcript test kit.
- **From B:** the four laws, as properties the test kit checks across pairs of caps.
- **Left out:**
  - B's kernel, its generic fact store, Policies, and Slots.
  - Assembling a Client from a chosen set of Features, which would let the set change what a Journal means.
  - `explain`.

  These can come back if third-party Features ever become real.

Two choices were made with the hybrid:

- **Provenance has four sources:** `ircd`, `replied`, `receipt`, and `ours`. `replied` keeps a fact learnt from a Lookup's reply, such as away status from `301`, apart from one the Ircd pushed as it happened, such as an `AWAY` from `away-notify`.
- **The floor is the Client's core, and Features refine it.** "Features refine the floor" is easier to explain than "the floor is a Feature that cannot be turned off".

Choices made while typing it:

- **Only a set can be partial.** `Fact<T>` has its `Partial` case only when `T` is a set, so a scalar fact cannot claim a lower bound.
- **Hooks always return `{ value, ...effects }`.** C let a hook return either the bare value or that object, which is ambiguous when the value is itself an object.
- **A Feature can set the encoding.** `UTF8ONLY` is a Feature with `encoding: Utf8Only`, so the core decodes by what is on and never asks for the token.
- **A hook that throws turns its Feature off** for the rest of the Connection, and is recorded (from A). A throw replays the same way, so replay still matches.
- **Inputs and outputs are Schemas,** because the Journal decodes them. News and Knowledge are types until the API needs their Schemas.

The first review found four gaps, fixed on 2026-11-08:

- **`OutboundLine` now checks what it promises.** Its Schema refuses NUL, CR, and LF in any parameter, a bad middle parameter, a bad command, more than 15 parameters, more than 510 bytes, and any tag that is not client-only or that runs past 4094 bytes. Decoding a recorded Line checks it again.
- **A Feature has a say over registration.** `hold` became `registration`: `Hold`, `Continue`, or `Abandon` with a reason. Features set no timers. While any Feature holds, the core keeps one deadline and calls the Feature's `expired` hook when it passes. A Connection that ends before registration is reported as `ConnectionFailed`, not as the end of a Session that never began.
- **`Fired` carries `due`,** the instant its `Wake` set, so a late firing from an earlier setting of the same timer is told apart. Fresh timer ids for every setting would also work, but would make the timer table grow.
- **The lint fence closes two gaps.** It now refuses Effect's services by subpath, such as `effect/Clock`, as well as from `effect`, and refuses `Math.random` and `DateTime`'s clock reads.

Three caps beyond the first Features changed the types on 2026-11-09, because other modules build on what they change. [IRCv3 to be aware of](#ircv3-to-be-aware-of) has the rest.

- **STS decides where to dial.** The core keeps an `StsPolicy` per hostname, shown in `inspect`, and `Dial` applies it: TLS on the policy's port until it expires, and never plaintext after a failed TLS Connection. It is not a Feature, because its policy outlives Connections and acts before any cap is negotiated. A plaintext Connection that sees an upgrade policy ends with `Upgrading`.
- **Our own Messages can be confirmed.** A `Message` we say carries `ours`, with its intent id and whether the Ircd will echo it. The echo arrives as `Confirmed`, with the Ircd's time, id, and final text, not as a second Message. The echo is tied to its intent by `labeled-response`, so the echo Feature needs both caps. A reply that `labeled-response` ties to an intent can also refuse it, so `RefusedReason` gained `Rejected`, carrying the numeric or standard reply code.
- **History arrives late, and twice.** `Message` and `Activity` carry `live` and an id. A Timeline orders by `at` and keeps one per id. An `Arrival` carries `live` for the `chathistory` batch to clear, and `answers` for `labeled-response` to fill.

With them, `UserKnowledge` gained `realname` for `setname`, and `Message` gained its client-only tags. `OutboundLine` now allows `label`, `batch`, and `draft/multiline-concat` as well as client-only tags. `SecretLine` and `Dial` note where SASL `SCRAM-SHA-256` and `EXTERNAL` would land.

The second review, of those changes and the ports, found five gaps, fixed on 2026-11-09:

- **An interrupted append could vanish from a follower.** The in-memory Journal stored an Entry and then published it, and an interrupt between the two lost it from every follower. The two are now one uninterruptible step. A new law interrupts appends at every point between two operations, which it does by making the scheduler yield every three operations.
- **The follow law did not test following.** A `follow` that gave only the past passed it. Followers now catch up before anything new is appended, and the new Entries are appended concurrently, for three positions.
- **A missing Credential stranded a join.** A `JoinWithKey` that cannot be filled sends nothing, so no reply comes back. `Unfilled` is now a Client input, with the `SecretLine` and why, so the Client decides what follows. It replaces the record that only the Journal saw.
- **The Runtime's fence had gaps.** It now refuses `fetch`, `WebSocket`, `crypto`, `effect/unstable/*`, `effect/testing` in production code, and Effect's `Clock` outside `clock.ts`.
- **The memory Transport did not frame.** It delivered empty and overlong Lines, which a real Transport skips or cuts. It now frames as the README says, and two laws check it.

The third review found three more, fixed the same day:

- **The fence could be reached around.** `globalThis.Date` and `globalThis.fetch` passed it. The global objects are now refused by name in the core and the Runtime, and `checkGlobalObject` is on. [`packages/fence`](../../packages/fence/README.md) now lints probe files to prove each refusal, and the first run of it found that `@iirc/*` matched one segment only, so the Client could import `@iirc/runtime/journal`. Subpaths are fenced now too.
- **An interrupted hangup could leave a Link open for good.** The memory Transport now closes in one uninterruptible step, and a law interrupts a hangup at every point between operations.
- **Filtered following was untested live.** The follow law now appends for both Networks while a follower watches one.

The fourth review found three more ways around the fence, fixed the same day:

- **`import { nowUnsafe } from "effect/DateTime"`** read the wall clock. `DateTime`'s functions that read the wall clock or the system's time zone are now refused as a property of any object, which covers aliases and namespaces, and as named imports.
- **Relative paths walked around package names.** `../../runtime/src/journal.ts` reached another package, and `./testing` reached a test kit as a directory. Relative imports may no longer leave a package, and `testing` is refused as a directory too.
- **The fence test could clobber files.** Its probes had fixed names. Each run now names its own, creates them exclusively, and removes only those.

The second review also asked for STS's persisted port to be pinned down: it is the port of the TLS Connection the policy arrived on, and `duration=0` removes the policy at once.

Deferred on purpose, to be added when their modules are designed:

- Lookups: an `Ask` input and an `Answer` in News. Asking for history after a Gap is one, and needs the latest time heard per Target.
- The `read` helpers that fold names for Views.
- `Gap` as News, because a Gap is derived from one Session's end and the next one's start.

## IRCv3 to be aware of

The first Features came from memory, so we went through the 48 IRCv3 specs in [`docs/irc-docs-2026-10-26/`](../irc-docs-2026-10-26/README.md) for others. Most fit the Feature seam as it is.

**Changed the types now:** `sts`, `echo-message` with `labeled-response`, and `chathistory`, as above.

**Would change the types, but can wait:**

- **SASL `SCRAM-SHA-256` and `EXTERNAL`.** PLAIN over TLS is enough for now. SCRAM's replies depend on the Credential and the Ircd's challenge, so it lands in `SecretLine` or on the Runtime's side. EXTERNAL logs in with a client certificate, which `Dial` would name as a Credential.
- **`message-redaction` and `channel-rename` (drafts).** A redaction is News that points at an earlier message id, which fits an append-only Journal. A rename means a Timeline cannot be keyed by a Channel's name. Both matter before Views choose their keys.
- **`TAGMSG` and client tags such as `typing` and `react`.** Enabling `message-tags` brings `TAGMSG` traffic. `typing` is sent as often as every 3 seconds per Target, and every received Line is journaled (ADR 0002), so it is the same worry as polling, arriving from the Ircd. Decide how the Journal holds it before turning it on.

**Fit the Feature seam as it is:**

| Cap or token | What it refines |
| --- | --- |
| `account-notify`, `extended-join`, `account-tag` | A User's account, which `keeps: user.account` covers |
| `chghost`, `userhost-in-names` | A User's mask |
| `setname` | A User's realname |
| `invite-notify` | An `Invited` Activity |
| `bot-mode` (`BOT` token) | Whether a User is a bot |
| `MONITOR`, `extended-monitor` | Whether a Direct Message partner is online, pushed rather than polled. The floor's alternative is polling with `ISON`, which we leave out. |
| `WHOX` | Richer `WHO` replies, with accounts, once on joining |
| `netsplit` and `netjoin` batches | A mass quit shown as one Activity |
| `standard-replies` | `FAIL`, `WARN`, and `NOTE` with codes to decide from, and good `Rejected` reasons |
| `draft/multiline` | Long Messages, both ways |
| `draft/pre-away` | Away before registration, for being away when no Frontend is attached |
| `draft/read-marker` | Our Read Marker, shared through an Ircd or bouncer that has it |
| `draft/extended-isupport` | ISUPPORT before registration |

**Not Features:**

- **Transport concerns.** SNI, which the TLS Transport must send, and WebSocket, which would be another Transport adapter.
- **Not relevant now.** `webirc`, the deprecated `tls` cap, `account-registration`, `metadata`, `network-icon`, `oper-tag`, `account-extban`, and `no-implicit-names`, because we want NAMES.
- **If iirc connects through a bouncer.** soju and ZNC have their own caps, such as `soju.im/bouncer-networks` and `znc.in/self-message`.

## The transcript test kit

The test kit lives at `@iirc/client/testing`, which production code may not import. A scenario is a transcript, one item per line:

| Item | Meaning |
| --- | --- |
| `<< :irc.test 001 iirc :Welcome` | The Ircd sends a Line: a `Received` at the current time. |
| `>> CAP LS 302` | The Client must `Send` exactly this next. |
| `>> AUTHENTICATE {AuthenticatePlain libera}` | The Client must `SendSecret` naming this Credential. |
| `-> dial irc.test:6697`, `-> hangup` | The Client must `Dial` or `Hangup`. |
| `== opened`, `== closed Reset` | Transport inputs. |
| `!! say #iirc :hello`, `!! configure +#iirc` | Owner inputs. Intent ids are given in order. |
| `+60s` | Advance the fake clock. Due timers fire in order, and their outputs are expected next. |
| `?? ignored Malformed MODE` | Expect an `Ignored`. |
| `...` | Allow any outputs up to the next expectation. |
| `# text` | A comment. |

- Matching is strict. Every `Send`, `SendSecret`, `Dial`, and `Hangup` must appear, in order. `Wake` is not written, because the fake clock carries it. An `Ignored` that is not written fails the scenario.
- A mismatch prints as a transcript diff, so a failing test reads as IRC.
- After every `play`, the kit replays the whole Journal from `initial` and checks that the states, outputs, and News are the same. Every scenario proves exact replay without asking.
- Preludes write the common parts: `registered({ caps, isupport })` writes the `CAP` exchange, or a `421` when `caps` is empty, so the floor is the default case. `joined(channel, names)` writes a join.
- `across(caps)` gives every pair of caps, plus none, for one scenario.
- The four laws run as properties over `across`:
  - **inert:** a Feature that is off changes nothing.
  - **refines:** more caps only sharpen what fewer know. A fact may go from unknown to partial to known, never the other way.
  - **replays:** replay gives the same states, outputs, and News.
  - **deactivates:** after `CAP DEL`, behaviour matches never having had the cap, except for facts marked stale.

The recorder that the transcript spike builds writes this format, so a recorded Session pastes in as a scenario. The kit is built with the Client, after the spikes. Today `@iirc/client/testing` holds only the scripted Client.

## Where this leaves step 1

Every part of the substrate has landed: the Line, Client, and Feature types, the scripted Client, and the Transport, Journal, Vault, and Clock ports in [`packages/runtime`](../../packages/runtime/README.md), each with a written interface and a fake, behind the lint fence. Each port also has laws, which every adapter of it must keep. Next come the spikes, and the modules that need only the substrate.
