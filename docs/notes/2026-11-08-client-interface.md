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

Deferred on purpose, to be added when their modules are designed:

- Lookups: an `Ask` input and an `Answer` in News.
- The `read` helpers that fold names for Views.
- `Gap` as News, because a Gap is derived from one Session's end and the next one's start.

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

These parts of the substrate have landed: the Line, Client, and Feature types, the written interfaces, the scripted Client, and the lint fence. The Transport, Journal, Vault, and Clock ports come next, each with an in-memory adapter.
