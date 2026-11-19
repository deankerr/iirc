# iirc

iirc is an always-on IRC client you can build on. A headless Daemon stays on your IRC Networks, records every Line in an append-only Journal, and exposes everything through a typed HTTP API, so a browser, a script, or an agent can drive it. It is built from a modular library, a pure protocol core with Effect runtime pieces on top, that other projects can use alone. Bun, TypeScript, and Effect. MIT licensed.

## What works today

- **The Daemon** stays on any number of Networks, redials with backoff, rejoins Channels, and answers the keepalive. It paces what it sends, and stops gracefully with a `QUIT`. It logs in to a service where there is no SASL, sends `OPER` with a Credential as each Session begins, takes a configured nick back once its holder leaves it, and answers CTCP `VERSION`, `PING`, `TIME`, and `CLIENTINFO` within a budget.
- **The RFC floor,** on any Ircd that speaks RFC 1459 and 2812, with or without cap negotiation.
- **IRCv3:** `cap-notify`, SASL PLAIN, `message-tags`, `server-time`, `batch`, `echo-message` with `labeled-response`, `multi-prefix`, `away-notify`, `standard-replies`, `UTF8ONLY`, and STS.
- **The Journal** in SQLite. A restart rebuilds every Network from it, and News resumes from any point in it.
- **The API:** configure and remove Networks, say things, hold Credentials, read what the Client knows and its machines' states, run Lookups, follow News as Server-Sent Events, read and close Timelines, and ask for a Message's Previews, which the Daemon fetches through a guard that keeps a stranger's link off our own network.
- **Uploads** to an S3-compatible bucket, stripped first of any metadata drawing them does not need if they are JPEG, PNG, GIF, WebP, HEIC, or AVIF images, or MP4 or MOV videos, and served at their links by a listener of their own.
- **The web frontend,** served by `iirc daemon --web` on the API's own origin: Timelines in split Panes, a Composer with commands, completion, and uploading, a keymap, search, Lookups, a Channel's members, a page's Preview under its link, the list of Uploads, notifications, options, and themes, on a desktop or a phone.

Most packages' READMEs end with what the package does not do yet.

## Quick start

Needs Bun 1.4.4.

```sh
bun install
bun run check         # lint and format (Ultracite)
bun run knip          # unused files and dependencies
bun run test          # every workspace's tests, with no network
bun run e2e           # a real Daemon against a private ngircd and Ergo, and in Chromium
bun run build:web     # the web frontend, into apps/web/dist
bun run build:iirc    # one executable, dist/iirc, with the web frontend inside
```

`bun run e2e` needs ngircd at `~/.local/opt/ngircd/ngircd`, or its path in `IIRC_NGIRCD`, fetches Ergo and MinIO itself, and needs Playwright's Chromium, which `bunx playwright install chromium` fetches.

## Run a Daemon

```sh
KEY=$(bun run iirc key create demo --data-dir ~/.local/share/iirc)   # prints the key once
bun run iirc daemon --data-dir ~/.local/share/iirc                    # serves on 127.0.0.1:7667
```

To use the web frontend, build it and serve it with the Daemon, then open `http://127.0.0.1:7667` and sign in with the key:

```sh
bun run build:web
bun run iirc daemon --data-dir ~/.local/share/iirc --web=apps/web/dist
```

To run it as a service instead, `bun run build:iirc` makes one executable with the web frontend inside, and `apps/iirc` installs it as a systemd user service.

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
  "declined": [], "fallbackEncoding": "windows-1252", "answerCtcp": true,
  "whoOnJoin": true
}'

curl -N "$API/news" -H "$AUTH"                         # News as Server-Sent Events
curl "$API/networks/libera/known" -H "$AUTH"           # Session, Self, Channels, members
curl "$API/networks/libera/inspect" -H "$AUTH"         # machine states, caps, timers, queues
curl -X POST "$API/networks/libera/say" -H "$AUTH" -H 'content-type: application/json' \
  -d '{ "kind": "Privmsg", "target": "#my-channel", "text": "hello from iirc" }'
```

Configuration always goes whole, so joining or parting a Channel is another `PUT`. `packages/api` lists every route.

## Repository

Each package's README says what it does and what it guarantees.

| Path | Pure | What |
| --- | --- | --- |
| `packages/protocol` | yes | The IRC protocol as values: Lines in and out, ISUPPORT, casemapping, CTCP, formatting, and links |
| `packages/client` | yes | The Client, iirc's pure understanding of one Network, and its transcript test kit |
| `packages/outbox` | yes | Pacing: which Line leaves next, and when |
| `packages/timelines` | yes | Timelines as a fold over News |
| `packages/frontend` | yes | The web frontend's core: what it shows, as plain data and reducers |
| `packages/api` | contract | The HTTP API every Frontend uses, as Schemas and typed errors |
| `packages/runtime` | no | The Runtime, and the ports it drives Clients through: Transport, Journal, Vault, and Clock |
| `packages/timeline-store` | no | The Timeline store port, its in-memory adapter, and its laws |
| `packages/preview-cache` | no | The Preview cache port, its in-memory adapter, and its laws |
| `packages/byte-store` | no | The byte store port, its in-memory adapter, and its laws |
| `packages/link-fetch` | no | The link fetch port, the address policy, and a fake adapter |
| `packages/transport-bun` | no | The production Transport: TCP and TLS on Bun |
| `packages/journal-sqlite` | no | The production Journal: Entries in SQLite |
| `packages/vault-file` | no | The production Vault: Credentials in a `0600` file |
| `packages/timeline-store-sqlite` | no | The production Timeline store, in SQLite |
| `packages/preview-cache-sqlite` | no | The production Preview cache, in SQLite |
| `packages/byte-store-s3` | no | The byte store in an S3-compatible bucket |
| `packages/link-fetch-bun` | no | The guard: fetches a stranger's link on Bun, pinned to the addresses it checked |
| `packages/daemon` | no | The Daemon: wires it all together and serves the API |
| `apps/iirc` | no | The `iirc` executable |
| `apps/web` | no | The web frontend: React over its core, built with Vite |
| `fixtures/transcripts` |  | Real Sessions on Ergo and ngircd, replayed in the tests |
| `fixtures/nicks` |  | How a nick is read, as data two packages' tests run |
| `fixtures/themes` |  | Real terminal theme files, for the theme importer's tests |

| Document                    | Read it for                              |
| --------------------------- | ---------------------------------------- |
| `VISION.md`                 | What iirc is for, and how we build it    |
| `GLOSSARY.md`               | What each word means here                |
| `ARCHITECTURE.md`           | How the pieces fit together              |
| `KNOWN-ISSUES.md`           | What is built but not yet right          |
| `docs/adr/`                 | Decisions and why                        |
| `docs/agents/`              | How the agent skills use this repository |
| `docs/irc-docs-2026-10-26/` | The IRC protocol documents we work from  |
| `AGENTS.md`                 | Instructions for every agent             |
