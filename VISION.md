# Vision

iirc is an always-on IRC client you can build on: a library, a headless daemon, and a web frontend, each good enough to stand alone.

IRC is an open protocol with decades of history and a living standards effort in IRCv3, yet its modern clients still leave room at the top. The field is wide open. We intend to be best in class.

## What we are building

1. **The library.** A modular IRC client library. Its protocol core is pure and does no I/O. Runtime concerns such as transports, negotiation, and reconnection compose on top. Take as much of it as a project needs and leave the rest.
2. **The daemon.** A headless IRC client that stays connected and remembers everything while your devices come and go. You operate it through a typed API, so a browser, a script, a bot, or an agent are all equal frontends. An agent can do anything through that API that a person can, and the daemon's state is open to inspection.
3. **The web frontend.** A fast, keyboard-first interface: terminal-chic, built for 2026. It is dense and calm on a desktop, at home on a phone, and it uses nothing the API does not offer to every other frontend.

The split is the point. Each component is meant for use in other projects, so none of them may depend on what sits above it.

## Who it is for

It is first a daily driver for its owner, held to a public standard. One deployment serves one owner across many devices. Shared, multi-user hosting is a far-future concern and does not shape today's design.

iirc is MIT licensed. We will publish the library once it has earned a stable API, and there is no rush.

## How we build

- **Effect-pilled.** Effect owns errors, concurrency, resources, and dependencies. XState owns finite lifecycles.
- **Parse, don't validate.** Bytes from the network and input from frontends become precise types at the boundary. A value that exists is a value that is valid, and that goes for outbound lines too: an IRC line that cannot be sent safely cannot be constructed.
- **Don't sync state. Derive it.** History is an append-only record of what happened. Everything else, including what a frontend shows, is a projection of it that can be rebuilt.
- **Deep modules, compositional packages.** Small interfaces hide real work. One package has one job, and packages combine without knowing about each other.
- **Contract-driven.** Schemas define the boundaries first, and implementations follow. `HttpApi` is the primary surface. Other transports, such as Effect RPC, SSE, or a wire format of our own, are adapters over the same contract.
- **Agent-drivable and observable from the start.** Everything the daemon can do is reachable through its API, and everything it knows can be inspected, except credentials. An agent can run a real daemon on a real network, see exactly what happened, and check its own work. We build this first because it is what makes everything else fast.
- **Bare IRC is the floor.** Every core behaviour works on a network with no IRCv3 at all. IRCv3 makes things better when it is available, and nothing depends on it.
- **Hostile input is the normal case.** Networks and users can send anything. Bad input never takes down a connection, loses a message, or reaches another system as a command.
- **Prove it against the real thing.** Shared conformance vectors, fuzzing, and real networks matter more than fakes.

## Core stack

Bun, TypeScript, Effect, and XState, with Ultracite as the fence. The local protocol documents in [`docs/`](docs/) are our reference for the spec. The language we use is defined in [`GLOSSARY.md`](GLOSSARY.md). We choose everything else when we reach it, and we are free to try more than one option. The frontend framework is an open experiment.

## Where we are going

The first proof is simple: the daemon stays on a real network for 30 days without losing a line, and the web frontend is good enough to be the only IRC client its owner uses.

After that, we can head in whichever direction is most interesting:

- **Depth:** the most correct IRC implementation available, with full use of IRCv3 wherever a network offers it.
- **Breadth:** more surfaces, more transports, more kinds of frontend.
- **Exploration:** experiments that a typed, remembering IRC client makes possible.

Good foundations keep all three open, so we do not have to choose in advance.

## Not now

These are not rejections. They wait until something real needs them:

- Multi-user hosting
- DCC
- A plugin or scripting system
- Serving IRC to other clients, as a bouncer does
- End-to-end encryption

## Keeping this document

This document holds goals and principles. Specifications and decisions live elsewhere. Change it when the direction changes, and keep it short enough to reread.
