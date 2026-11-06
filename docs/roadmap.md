# Roadmap

Where iirc is going, and what stands in the way. [`requirements.md`](requirements.md) holds every requirement and its status. [`VISION.md`](../VISION.md) holds the goals.

## Milestones

Each milestone is a working Daemon. Order is by what makes the next one possible.

| # | Name | Delivers | Done when | Status |
| --- | --- | --- | --- | --- |
| 1 | Stays on | LOG, CONF, CRED, CONN except CONN-5, LIVE, SEND lanes and flood control, a thin Send, `/entries`, Channel membership, RUN, multiple Networks, AUTH | It survives kills, drops, and refusals on fserv and loses nothing | Built. The soak test is running |
| 2 | Knows the Network | KNOW, MSG, HOST, PROT, Activity, a Channel read, an Activity read | Derived state matches `NAMES` and `MODE` after a netsplit and a reconnect | Built. `proof:floor` shows it on two linked ngircds |
| 3 | Full control | CONN-5, the rest of SEND, Lookups, Acting | Everything a person does in irssi can be done through the API | Planned |
| 4 | Ready for Frontends | `/bootstrap`, `/stream`, VIEW, STORE, OBS | The web frontend can start without asking for a Daemon change | Planned |
| 5 | Better with IRCv3 | [IRCv3 enhancements](#ircv3-enhancements) | Ergo gives more, ngircd still passes | Planned |

### How milestone 1 was built

Each step was a working Daemon.

1. One Network, the durable Log, the machine as a fold, and a kill test.
2. Reconnecting and refusals: LIVE, CONN-3, CONN-4, CONN-7, SEND-1 to SEND-4, and LOG-9.
3. Configuration, multiple Networks, API keys, Channel membership, LOG-11's reader, and TLS key pinning.
   - That is CONF-1, CONF-2, CONF-4, CONF-6, CONF-3 without Credentials, services, connect commands, or notification levels, and CONF-5's Join and Part, keyless until Credentials existed.
   - AUTH-1 to AUTH-5, and AUTH-6's rule that keys travel in headers. Its WebSocket and AUTH-7's cookie come with the web frontend in milestone 4.
   - Every Network flag left `iirc daemon`, which takes only a data directory and a listen address (CONF-4).
4. Credentials, CONN-2's `PASS`, CONN-6, and the service unit.
   - That is CRED-1 to CRED-4, LOG-6, LOG-7, CONF-3's Credentials, services, and connect commands, and Channel keys for Join (CONF-5).
   - Also RUN-2 and RUN-5, because the soak test freezes the Log format, and every change after it needs a migration and a backup.
   - SASL details wait for milestone 5. A TLS client certificate is a Credential holding the certificate and key in PEM.

### How milestone 2 is built

Each step is a working Daemon. Derived state lives in `Standing` and in derived tables, which are created at startup, so none of it changes the frozen Log format. New Tuning travels whole in each `attempt` Entry, so decoding and CTCP replies stay folds over the Log, and older `attempt` Entries take the defaults.

1. Pure protocol pieces in `@iirc/protocol`: formatting spans and stripping (MSG-3), CTCP parsing with `ACTION` as a Message and DCC parsed but never acted on (PROT-2, PROT-5), `FAIL`, `WARN`, and `NOTE` (PROT-6), and decoding through UTF-8, a fallback, then Latin-1 (MSG-4). Each with conformance vectors.
2. Knowing the Network in `@iirc/state`: every `RPL_ISUPPORT` token (KNOW-2), `UTF8MAPPING`, `rfc8265`, and an override (KNOW-3), Self's mask, modes, and away state (KNOW-1), Channels' topic, modes, and ranked members, with `353` to `366` as one replacement (KNOW-4, KNOW-6), Users as seen (KNOW-7), and `470` (KNOW-9).
   - Fold cost and bounds are measured first: a large `NAMES` burst and a netsplit's `QUIT` storm decide the data structure, and members and Users get bounds of their own.
3. Placement and Activity in the Log's fold: where each Line belongs (MSG-2, MSG-6), Activity as a derived `activity` table (MSG-5), `QUIT` and `NICK` attributed to shared Channels (KNOW-8), and unknown Lines (PROT-1). A rebuilt table equals a live one.
4. The Daemon asks: a pure planner over `Standing`, like `joinPlan`, for `MODE` on join, `WHO` for `user@host`, a debounced `NAMES` after a prefix mode is removed, and a re-read of an uncertain Channel, all through the background lane (KNOW-5). Debounces are absolute deadlines in `Standing`.
5. CTCP replies and floods: `VERSION` and `PING` by default, `TIME` opt-in and in UTC (PROT-3), only ever to a parsed User nick, and the encoding, casemapping, and CTCP Tuning (CONF-3). The limits are a window in `Standing` folded from the Log (PROT-4, HOST-3): a reply counts from when it is decided, and keeps counting while it is pending, until it is recorded as sent, when it counts from then, or as Dropped. One not written within the Network's window of being decided is Dropped as it reaches the head of the lane, so no more than the limit leave in any window. Any other CTCP `NOTICE` Self sends counts once recorded.
6. Reads and proof: a Channel's topic, modes, members, and `at` from `GET /networks/{id}/targets/{target}`, and Activity by cursor, both with participant text marked untrusted (HOST-4). `proof:floor` links two ngircds, splits and rejoins them, reconnects, and compares derived members and modes with a raw IRC client's `NAMES` and `MODE`.
   - The split is an IRC operator's `DISCONNECT`, and the rejoin its `CONNECT`, so the far side's Users live through it and come back in the link's burst. Killing the far ngircd would take them with it, and ngircd's own redial, at least 5 seconds after the last, would race the checks made during the split.
   - The comparison waits for the Daemon to settle by the API alone: a Message sent after what the raw client saw is recorded, nothing is uncertain, every read is answered, and `at` holds still.
   - ngircd's burst gives a member with `@+` as `MODE #chan +ov nick`, one parameter for two prefix modes. The Daemon finds it uneven, marks the Channel uncertain, and reads `MODE` and `NAMES` again, which is what KNOW-6 asks.

Decided at the start:

- The Channel read and the Activity read come forward from milestone 4, because "done when" needs them. Unread counts and Timelines stay in milestone 4.
- The fallback encoding is any WHATWG `TextDecoder` label, which Bun ships, so no encoding is added one at a time.
- The netsplit runs inside `proof:floor`, on two linked ngircds on loopback.

Groundwork for milestone 2 came early, because milestone 1 needed it: `@iirc/state` folds Self, the Channels Self is in, their keys, and part of `RPL_ISUPPORT`, and the Log derives Messages and Gaps.

## The soak test

PROOF-5: two Daemons share a Channel, one sends a counted Message every minute, and the other's Log is checked for losses. [The soak guide](guides/soak.md) says how it runs.

- **Status:** running since 2026-11-04, from the tag `soak-1`, on the floor Ircd and a real TLS Network. It passes after 30 days with every Gap explained, so 2026-12-04 at the earliest.
- **Pinned:** the soak runs a pinned copy of a tagged build, so day-to-day work cannot disturb it. Upgrading it on purpose is in the guide.
- **The Log format is frozen.** Its migrations were folded into `1_initial` when the soak began. Every change to the Log from here on is a new migration (RUN-5), and a build that needs one is a reason to start the soak again.
- **It runs in the background.** Nothing waits for it, and the Daemon runs alongside whatever IRC client the Owner uses.
- An unexplained loss starts the 30 days again once it is understood.

## IRCv3 enhancements

Milestone 5. Each is detected, never assumed, and nothing depends on it ([ADR 0001](adr/0001-bare-irc-is-the-floor.md)). The requirements are CAP, DEDUP, and FILL in [`requirements.md`](requirements.md#ircv3-enhancements).

### Capabilities

| Capability | Improves | Without it |
| --- | --- | --- |
| `sasl` | Authentication before joining | `PASS` and service `IDENTIFY` (CONN-6) |
| `server-time` | True Message times, kept beside `at` | Time of receipt |
| `echo-message` with `labeled-response` | Confirmed sends, enabled only as a pair | Own outbound Lines (MSG-1) |
| `labeled-response` | Exact Lookup and send correlation | The table (LOOK-3), best-effort errors (SEND-9) |
| `message-tags` | Carries `msgid` for deduplication | Each Line stands alone |
| `batch` | Grouped netsplits | Each Line stands alone |
| `draft/chathistory`, `draft/event-playback` | [Filling Gaps](requirements.md#filling-gaps) | The Gap remains visible |
| `away-notify`, `account-notify`, `extended-join`, `chghost`, `setname`, `userhost-in-names`, `multi-prefix` | Fresher User state | `WHO` and `NAMES` when needed |
| `standard-replies`, `invite-notify` | Better-typed errors and Activity | Numerics |
| `draft/multiline` | One Message across Lines | Splitting (SEND-5) |
| `sts` | Persisted upgrade to TLS | Configured TLS (CONN-1) |
| `draft/read-marker` | Read Markers shared with other IRC clients | Shared among Frontends only |

### Other mechanisms

These are not capabilities, so they are detected differently.

| Mechanism | Detected by | Improves | Without it |
| --- | --- | --- | --- |
| `MONITOR` | `RPL_ISUPPORT` | Instant nick regain, presence | `ISON` (CONN-5) |
| `WHOX` | `RPL_ISUPPORT` | Richer User state | `WHO` |
| `BOT` | `RPL_ISUPPORT` | Agents can mark Self as a bot | No marking |
| `reply`, `react`, `typing` | Client tags over `message-tags` | Richer conversation | Not shown |

## Beyond the first proof

Wanted, but not needed for the first proof:

- Pushing notifications to a phone through Web Push or a webhook.
  - It must not key on "no Frontend connected", because an always-on agent would suppress it forever.
  - It waits a few seconds and skips anything already read, sends a dismissal when a Read Marker moves, prunes dead subscriptions, and blocks internal addresses.
- Automatic away when no Frontend is connected.
- Importing logs from WeeChat, ZNC, or The Lounge.
- An MCP adapter and an `iirc` command-line Frontend.
- Link previews fetched by the Daemon, so that a Frontend's address is not exposed.
- A watch list of Users, built on `MONITOR` and `ISON`.

## Open questions

- Should the API, the web frontend, and an MCP adapter be projected from one capability definition, as rat-stack does? It would help once MCP is real, and is not needed before then.

For the architectural review that opens milestone 3:

- **Nick after a routine reconnect.** On ngircd, the `MODE` and `WHO` that follow each `JOIN` (KNOW-5) count against its per-command penalty. So after a disconnect and connect, the old `QUIT` can still be unread, the new registration gets `433`, and the Daemon comes back on a fallback nick. Nick regain is CONN-5, in milestone 3. This was seen with `proof:floor`'s 1 s quit wait, and has not been tried with the default 2 s.
- **The pace of Channel reads.** With one read in flight per Network and a 60 s timeout, an Ircd that ignores every read delays the last of 1024 Channels by about 17 hours. That is bounded, and errors answer at once. Whether reads should run more in parallel, time out sooner, or become Tuning is open.

## Risks

- **Effect stability:** only Effect's core is stable. `http`, `http-api`, `rpc`, `sql`, `socket`, `cli`, `workers`, `crypto`, and every package outside `effect`, including `platform-bun` and `vitest`, can break in a minor release.
  - The catalog pins exact versions, and these APIs stay behind deep services.
- **Reference repos lag:** `effect-solutions` is a v4 beta, and rat-stack uses Node. Installed source is the authority.

## Unproven

- The web frontend, and every deployment shape but the stand-alone Daemon ([ADR 0007](adr/0007-one-binary-shapes-by-argument.md)).
- Commit latency under real traffic. It was measured on synthetic data, and the soak is the first real load.
- arm64, musl, macOS, and Windows builds. FTS5 on macOS.
- Ergo has not been run. Its behaviour here, such as replaying always-on `JOIN`s after `376`, comes from reading its source.
- The netsplit proof covers ngircd alone, linked with itself, with no `multi-prefix`, so a member's lower prefixes are compared only as `NAMES` shows them, which is the highest. It does not cover a split between different Ircds, a split seen from the far side, a `QUIT` storm of many Users, a split while a read is in flight, Channel modes that differ across the split and merge in the burst, or a nick collision at the rejoin.
