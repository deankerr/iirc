# Vision

iirc is an always-on IRC client you can build on: a library, a headless Daemon, and a web frontend, each good enough to stand alone.

IRC is an open protocol with decades of history and a living standards effort in IRCv3, yet its modern clients still leave room at the top. The field is wide open. We intend to be best in class.

## What we are building

1. **The library.** A modular IRC client library. Its protocol core is pure and does no I/O. Runtime concerns such as transports, negotiation, and reconnection compose on top. Take as much of it as a project needs and leave the rest.
2. **The Daemon.** A headless IRC client that stays connected and remembers everything while your devices come and go. It is a composition of the library's packages, with durability, Configuration, and an API added on top. You operate it through a typed API, so a browser, a script, a bot, or an agent are all equal Frontends. An agent can do anything through that API that a person can, and the Daemon's state is open to inspection.
3. **The web frontend.** A fast, keyboard-first interface: terminal-chic, built for 2026. It is dense and calm on a desktop, at home on a phone, and it uses nothing the API does not offer to every other frontend.

The split is the point. Each component is meant for use in other projects, so none of them may depend on what sits above it.

## Who it is for

It is first a daily driver for its Owner, held to a public standard. One deployment serves one Owner across many devices. Shared, multi-user hosting is a far-future concern and does not shape today's design.

iirc is MIT licensed. We will publish the library once it has earned a stable API, and there is no rush.

## How we build

- **Effect-pilled.** Effect owns errors, concurrency, resources, and dependencies, and wins where it overlaps Bun ([ADR 0005](docs/adr/0005-effect-wins-where-it-overlaps-bun.md)). Finite lifecycles are pure folds over the Log ([ADR 0003](docs/adr/0003-machines-are-projections.md)).
- **Parse, don't validate.** Bytes from the network and input from frontends become precise types at the boundary. A value that exists is a value that is valid, and that goes for outbound lines too: an IRC line that cannot be sent safely cannot be constructed.
- **Don't sync state. Derive it.** History is an append-only record of what happened. Everything else, including Configuration and what a Frontend shows, is a projection of it that can be rebuilt ([ADR 0002](docs/adr/0002-the-log-holds-bytes.md), [ADR 0004](docs/adr/0004-configuration-lives-in-the-log.md)).
- **Deep modules, compositional packages.** Small interfaces hide real work. One package has one job, and packages combine without knowing about each other.
- **Contract-driven.** Schemas define the boundaries first, and implementations follow. `HttpApi` is the primary surface. Other transports, such as Effect RPC, SSE, or a wire format of our own, are adapters over the same contract.
- **Agent-drivable and observable from the start.** Everything the Daemon can do is reachable through its API, and everything it knows can be inspected, except Credentials. An agent can run a real Daemon on a real Network, see exactly what happened, and check its own work. We build this first because it is what makes everything else fast.
- **Bare IRC is the floor.** Every core behaviour works on a Network with no IRCv3 at all. IRCv3 makes things better when it is available, and nothing depends on it ([ADR 0001](docs/adr/0001-bare-irc-is-the-floor.md)).
- **Hostile input is the normal case.** Networks and Users can send anything. Bad input never takes down a Connection, loses a Message, or reaches another system as a command. Security is proportionate: we defend against hostile Networks and text, not the Owner's own software ([ADR 0006](docs/adr/0006-proportionate-security.md)).
- **Prove it against the real thing.** Shared conformance vectors, fuzzing, and real networks matter more than fakes.

## Core stack

Bun, TypeScript, and Effect, with Ultracite as the fence. The local protocol documents in [`docs/irc-docs-2026-10-26/`](docs/irc-docs-2026-10-26/README.md) are our reference for IRC. The language we use is defined in [`GLOSSARY.md`](GLOSSARY.md). We choose everything else when we reach it, and we are free to try more than one option. The frontend framework is an open experiment.

## Where we are going

The first proof is simple: the Daemon stays on a real Network for 30 days without losing a Line, and the web frontend is good enough to be the only IRC client its Owner uses.

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

This document holds goals and principles. Requirements live in [`docs/requirements.md`](docs/requirements.md), plans in [`docs/roadmap.md`](docs/roadmap.md), and decisions in [`docs/adr/`](docs/adr/). Change it when the direction changes, and keep it short enough to reread.
