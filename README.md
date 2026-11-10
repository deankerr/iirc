# iirc

iirc is an always-on IRC client you can build on. A headless Daemon stays on your IRC Networks, records every Line in an append-only Journal, and exposes everything through a typed HTTP API, so a browser, a script, or an agent can drive it. It is built from a modular library, a pure protocol core with Effect runtime pieces on top, that other projects can use alone. Bun, TypeScript, and Effect. MIT licensed. [`VISION.md`](VISION.md) says what it is for.

## What works today

- **The Daemon** stays on any number of Networks, redials with backoff, rejoins Channels, and answers the keepalive. It paces what it sends, and stops gracefully with a `QUIT`.
- **The RFC floor,** on any Ircd that speaks RFC 1459 and 2812, with or without cap negotiation.
- **IRCv3:** `cap-notify`, SASL PLAIN, `message-tags`, `server-time`, `batch`, `echo-message` with `labeled-response`, `multi-prefix`, `away-notify`, `UTF8ONLY`, and STS.
- **The Journal** in SQLite. A restart rebuilds every Network from it, and News resumes from any point in it.
- **The API:** configure Networks, say things, hold Credentials, read what the Client knows and its machines' states, and follow News as Server-Sent Events.

Not built yet: the web frontend and Views. Each module's README ends with what it does not do yet.

## Quick start

Needs Bun 1.4.4.

```sh
bun install
bun run check         # lint and format (Ultracite)
bun run knip          # unused files and dependencies
bun run test          # every workspace's tests, with no network
bun run e2e           # a real Daemon against a private ngircd and Ergo
```

`bun run e2e` needs ngircd at `~/.local/opt/ngircd/ngircd`, or its path in `IIRC_NGIRCD`, and fetches Ergo itself. [The Daemon's README](packages/daemon/README.md#end-to-end) says what it covers.

## Run a Daemon

```sh
KEY=$(bun run iirc key create demo --data-dir ~/.local/share/iirc)   # prints the key once
bun run iirc daemon --data-dir ~/.local/share/iirc                    # serves on 127.0.0.1:7667
```

Then, from another shell, add a Network and watch it:

```sh
API=http://127.0.0.1:7667/api
AUTH="Authorization: Bearer $KEY"

curl -X PUT "$API/networks/libera" -H "$AUTH" -H 'content-type: application/json' -d '{
  "enabled": true,
  "ircds": [{ "host": "irc.libera.chat", "port": 6697, "tls": true }],
  "nicks": ["my-nick"], "username": "iirc", "realname": "iirc",
  "login": { "_tag": "None" },
  "channels": [{ "name": "#my-channel" }],
  "declined": [], "fallbackEncoding": "windows-1252"
}'

curl -N "$API/news" -H "$AUTH"                         # News as Server-Sent Events
curl "$API/networks/libera/known" -H "$AUTH"           # Session, Self, Channels, members
curl "$API/networks/libera/inspect" -H "$AUTH"         # machine states, caps, timers, queues
curl -X POST "$API/networks/libera/say" -H "$AUTH" -H 'content-type: application/json' \
  -d '{ "kind": "Privmsg", "target": "#my-channel", "text": "hello from iirc" }'
```

Configuration always goes whole, so joining or parting a Channel is another `PUT`. [The API's README](packages/api/README.md) lists every route.

## Repository

| Path | What |
| --- | --- |
| [`packages/protocol`](packages/protocol) | The IRC protocol as values: Lines in and out, ISUPPORT, casemapping, CTCP, and formatting |
| [`packages/client`](packages/client) | The pure IRC client for one Network, and its transcript test kit |
| [`packages/outbox`](packages/outbox) | Pacing: which Line leaves next, and when |
| [`packages/runtime`](packages/runtime) | The Runtime, and the ports it drives Clients through: Transport, Journal, Vault, and Clock |
| [`packages/transport-bun`](packages/transport-bun) | The production Transport: TCP and TLS on Bun, verified, framed, and bounded |
| [`packages/journal-sqlite`](packages/journal-sqlite) | The production Journal: Entries in SQLite, durable before `append` returns |
| [`packages/vault-file`](packages/vault-file) | The production Vault: Credentials in a `0600` file, written atomically |
| [`packages/api`](packages/api) | The HTTP API's contract, which every Frontend uses |
| [`packages/daemon`](packages/daemon) | The Daemon: wires it all together and serves the API |
| [`apps/iirc`](apps/iirc) | The `iirc` executable |
| [`fixtures/transcripts`](fixtures/transcripts) | Real Sessions on Ergo and ngircd, replayed in the tests |
| [`docs`](docs) | Architecture, decisions, and the IRC specifications |

## Documentation

| Document | Read it for |
| --- | --- |
| [`VISION.md`](VISION.md) | Goals and principles |
| [`GLOSSARY.md`](GLOSSARY.md) | What our words mean. Capitalised terms, such as Line and Entry, are defined there |
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit together, and where to extend them |
| [`docs/adr/`](docs/adr/) | Decisions and why |
| Each package's README | Its written interface: what it does, guarantees, and does not do yet |
| [`docs/irc-docs-2026-10-26/`](docs/irc-docs-2026-10-26/README.md) | The IRC protocol documents we work from |
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents |
