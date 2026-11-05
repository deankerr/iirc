# iirc

iirc is an always-on IRC client you can build on. A headless Daemon stays on your IRC Networks, records every Line in an append-only Log, and exposes everything through a typed HTTP API, so a browser, a script, or an agent can drive it. It is built from a modular library, a pure protocol core with Effect runtime pieces on top, that other projects can use alone. Bun, TypeScript, and Effect. MIT licensed. [`VISION.md`](VISION.md) says where it is going.

## Status

- **Milestone 1, "Stays on", is built:** the durable Log, Configuration, Credentials, reconnecting and refusals, flood control, multiple Networks, API keys, and a systemd service.
- **The 30-day soak test (PROOF-5) is running** since 2026-11-04.
- **Next:** milestone 2, "Knows the Network". There is no web frontend yet.

[`docs/roadmap.md`](docs/roadmap.md) has the milestones, and [`docs/requirements.md`](docs/requirements.md) has the status of every requirement.

## Quick start

Needs Bun 1.4.4.

```sh
bun install
bun run test          # every workspace's tests
bun run check         # lint and format (Ultracite)
bun run build         # apps/iirc/dist/iirc and apps/soak/dist/iirc-soak
bun run proof:floor   # the floor proof against private ngircds
```

To run a Daemon, make its first key, and add a Network, follow [the running guide](docs/guides/running.md). In short:

```sh
export IIRC_DATA_DIR=/tmp/iirc
KEY=$(apps/iirc/dist/iirc key create --name owner)   # shown only this once
apps/iirc/dist/iirc daemon --http-port 7667 &
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:7667/api/status
```

## Repository

| Path | What |
| --- | --- |
| [`packages/protocol`](packages/protocol/README.md) | Bytes to Lines and back, safely. Pure |
| [`packages/state`](packages/state/README.md) | What an Ircd's Lines mean for one Session. Pure |
| [`packages/lifecycle`](packages/lifecycle/README.md) | The Network machine as a pure fold |
| [`packages/session`](packages/session/README.md) | Hosts one Network with Effect, recording before acting |
| [`packages/log`](packages/log/README.md) | The durable Log in SQLite |
| [`packages/api`](packages/api/README.md) | The HTTP API's contract |
| [`packages/daemon`](packages/daemon/README.md) | Configuration, Credentials, keys, and Network supervision |
| [`apps/iirc`](apps/iirc/README.md) | The `iirc` executable and its command-line Frontends |
| [`apps/soak`](apps/soak/README.md) | `iirc-soak`, the soak test's harness |
| [`packaging/systemd`](packaging/systemd) | The `iirc@.service` template and the soak's units |
| [`docs`](docs) | Everything below |

## Documentation

| Document | Read it for |
| --- | --- |
| [`VISION.md`](VISION.md) | Goals and principles |
| [`GLOSSARY.md`](GLOSSARY.md) | What our words mean. Capitalised terms, such as Line and Entry, are defined there |
| [`docs/architecture.md`](docs/architecture.md) | How the packages fit together, with diagrams |
| [`docs/requirements.md`](docs/requirements.md) | Every requirement, by ID, and its status |
| [`docs/roadmap.md`](docs/roadmap.md) | Milestones, the soak test, IRCv3 plans, risks |
| [`docs/adr/`](docs/adr/) | Decisions and why |
| [`docs/guides/running.md`](docs/guides/running.md) | Installing and running a Daemon |
| [`docs/guides/soak.md`](docs/guides/soak.md) | Running the soak test |
| [`docs/irc-docs-2026-10-26/`](docs/irc-docs-2026-10-26/README.md) | The IRC protocol documents we work from |
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents |
