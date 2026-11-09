# iirc

iirc is an always-on IRC client you can build on. A headless Daemon stays on your IRC Networks, records every Line in an append-only Journal, and exposes everything through a typed HTTP API, so a browser, a script, or an agent can drive it. It is built from a modular library, a pure protocol core with Effect runtime pieces on top, that other projects can use alone. Bun, TypeScript, and Effect. MIT licensed. [`VISION.md`](VISION.md) says what it is for.

## Status

**Being reformulated.** Milestone 2's code was retired on 2026-11-08 and is kept at the tag `m2`. New modules port from it on purpose, and never import it. [The architecture proposal](docs/notes/2026-11-07-architecture-proposal.md) describes the shape we are building, and §11 says where we start.

## Quick start

Needs Bun 1.4.4.

```sh
bun install
bun run check         # lint and format (Ultracite)
bun run knip          # unused files and dependencies
bun run test          # every workspace's tests
```

## Repository

| Path | What |
| --- | --- |
| [`packages/protocol`](packages/protocol) | The IRC protocol as values: Lines in and out, and where a Credential can go |
| [`packages/client`](packages/client) | The pure IRC client for one Network |
| [`packages/runtime`](packages/runtime) | The ports the Runtime drives Clients through: Transport, Journal, Vault, and Clock |
| [`packages/fence`](packages/fence) | Tests that the lint fence refuses what it should, and allows what it should |
| [`docs`](docs) | Everything below |

## Documentation

| Document | Read it for |
| --- | --- |
| [`VISION.md`](VISION.md) | Goals and principles |
| [`GLOSSARY.md`](GLOSSARY.md) | What our words mean. Capitalised terms, such as Line and Entry, are defined there |
| [`docs/adr/`](docs/adr/) | Decisions and why |
| [`docs/notes/`](docs/notes/) | Proposals and surveys, including the architecture proposal |
| [`docs/irc-docs-2026-10-26/`](docs/irc-docs-2026-10-26/README.md) | The IRC protocol documents we work from |
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents |
