# Requirements

This is what the Daemon must do, in one place. [`VISION.md`](../VISION.md) says why, [`GLOSSARY.md`](../GLOSSARY.md) defines the words, and [`architecture.md`](architecture.md) says where the work lives. [`roadmap.md`](roadmap.md) holds the milestones and plans.

The floor in [ADR 0001](adr/0001-bare-irc-is-the-floor.md) applies throughout: every requirement here works on a Network with no IRCv3, unless it appears in [IRCv3 enhancements](#ircv3-enhancements).

Reading this document:

- Requirements have stable IDs so that tests and commits can cite them. A test names the ID it proves (PROOF-1).
- Numbers are defaults that the Owner can change per Network.
- A "Deferred" bullet is a minor decision that will be easier once the foundation exists.
- **Status** is given per area, and on an ID where it differs. "Done" means built and tested in milestone 1. "M2" to "M5" name the [milestone](roadmap.md#milestones) it is planned for. "Partial" says what exists and what waits.

## Status at a glance

| Area | IDs | Status |
| --- | --- | --- |
| [The Log](#the-log) | LOG-1 to LOG-11 | Done. Causes for later behaviours, and the reads behind later surfaces, arrive with them |
| [Configuration](#configuration) | CONF-1 to CONF-6 | Done, except SASL (M5), notification levels (M4), and nick and away (M3) |
| [Credentials](#credentials) | CRED-1 to CRED-4 | Done |
| [Connecting](#connecting) | CONN-1 to CONN-7 | Done, except CONN-5 (M3) |
| [Staying connected](#staying-connected) | LIVE-1 to LIVE-11 | Done. Gaps in Timelines wait for Timelines (M4) |
| [Sending](#sending) | SEND-1 to SEND-11 | SEND-1 to SEND-4 and `JOIN` splitting done. The rest M3 |
| [Network state](#network-state), [Channels and Users](#channels-and-users) | KNOW-1 to KNOW-9 | M2. `@iirc/state` holds Self, Channels with topics, modes, and ranked members, Users seen, every `RPL_ISUPPORT` token, and every casemapping. A Channel is read through `GET /networks/{id}/targets/{target}` |
| [Messages and Activity](#messages-and-activity) | MSG-1 to MSG-6 | Done. Messages and Activity are derived in the Log and read through `/messages` and `/activity`, with spans (MSG-3) |
| [Timelines and attention](#timelines-and-attention) | VIEW-1 to VIEW-10 | M4 |
| [Frontend storage](#frontend-storage) | STORE-1 to STORE-5 | M4 |
| [Lookups](#lookups) | LOOK-1 to LOOK-7 | M3 |
| [Protocol behaviour](#protocol-behaviour) | PROT-1 to PROT-6 | Done. PROT-1, PROT-2, PROT-5, and PROT-6 are derived in the Log, and CTCP replies are decided in `Standing` |
| [Hostile input](#hostile-input) | HOST-1 to HOST-5 | HOST-1 to HOST-4 done, HOST-5 in part |
| [API](#api) | API-1 to API-10 | Done for the surfaces that exist. `/stream` and `/bootstrap` M4, Acting M3 |
| [Access](#access) | AUTH-1 to AUTH-7 | AUTH-1 to AUTH-5 done, AUTH-6 in part. AUTH-7 M4 |
| [Observability](#observability) | OBS-1 to OBS-4 | OBS-4 done, OBS-1 in part. OBS-2 and OBS-3 M4 |
| [Running it](#running-it) | RUN-1 to RUN-5 | Done. One deployment shape so far |
| [Proof](#proof) | PROOF-1 to PROOF-5 | PROOF-1 and PROOF-4 done, PROOF-2 and PROOF-3 in part. PROOF-5 running |
| [IRCv3 enhancements](#ircv3-enhancements) | CAP-1 to CAP-4, DEDUP-1 to DEDUP-2, FILL-1 to FILL-5 | M5 |

## The Log

**Status:** Done.

The Daemon runs one Log and any number of Networks. Everything durable is an Entry in the Log. Everything else is derived from it ([ADR 0002](adr/0002-the-log-holds-bytes.md)).

- **LOG-1.** There is one Log per Daemon. Sequence numbers are global, start at 1, have no gaps, and are never reused, so one cursor can resume everything.
- **LOG-2.** An Entry is one of:
  - **Line:** one Line in either direction, with its Network, its Connection, and a cause if outbound.
  - **Connection:** an attempt, opening, closing, or close, with the Ircd, TLS details, and reason. An attempt names the nicks it will try, how many Lines its login sequence holds, and which nicks are services (CONN-6). An opening over TLS records the protocol, the cipher, the pin of the key the Ircd presented, and whether a certificate authority or a pin verified it (CONN-1).
    - Closing is recorded whenever the Daemon decides to end a Connection, with its reason and whether it chose to leave (LIVE-9). Only a chosen leave is not a failure.
    - A close's reason is the first one given, unless the Ircd's own words, from its `ERROR`, come while the close is under way. They outrank it, because a Network that turns us away often closes the socket before its `ERROR` is read (LIVE-5). A leave the Daemon chose keeps its own reason, because an `ERROR` then only answers its `QUIT`.
    - Earlier Daemons marked some closes `refused`, and recorded a `refusalBackoffMillis` in each `attempt`'s Tuning. A Log keeps both, and nothing reads them. Migration `2_tuning_without_refusals` marks the change, so a binary from before refuses a Log written since (RUN-5).
    - A Connection the Log could not close, because appends were failing (LOG-9), gets its close once appends succeed, with that reason, so that it is never mistaken for a killed process.
  - **Change:** something the Owner altered, such as Configuration, a Read Marker, an ignore, or an API key, with the name of the key that altered it, or `local` for `iirc key create` (AUTH-4), and the Network it concerns, if any.
  - **Daemon:** a start or stop, with its version.
  - **Dropped:** an outbound Line that was queued and never written, or whose write did not complete, with the reason. A Line counts as written once the kernel has taken it, not once a buffer in the process has.
  - **Deadline:** a timer that expired with no trace on the wire, such as the end of the login wait (CONN-6) or the burst (CONN-7). Without it, past state could not derive those phases.
- **LOG-3.** A Line Entry stores the bytes that crossed the Connection, not a decoded or parsed form. Fixing the parser later therefore fixes old history too. Redaction (LOG-6, LOG-7) is the only exception.
- **LOG-4.** Nothing acts on a Line before it is recorded.
  - Complete Lines from a socket read are committed together, at most 1024 to a transaction, and only then acted on, including replying to `PING`. The cap keeps a flood of tiny Lines from holding the writer.
  - An outbound Line is appended as it leaves its queue, immediately before the write, so Log order matches wire order.
  - A crash can leave a Line recorded but unsent, and can never leave one sent but unrecorded.
  - SQLite runs with `synchronous=FULL`, because a Line that was committed must survive power loss as well as a killed process.
  - Bytes the Ircd sent that the Daemon never read are lost with the Connection. They fall inside a Gap.
  - What the Daemon has read but not yet recorded is bounded in bytes, so that the rest of a flood waits in the kernel. Everything it has read is recorded before the Connection's close, including when it is stopping.
- **LOG-5.** An outbound Entry records its cause, so "Why did the Daemon send that?" always has an answer.
  - A Frontend's request is recorded as `key:` and its key name, such as `key:phone`. The request ID joins it with SEND-10 _(M3)_.
  - A remembered Join is a Change, and the reconciler sends its `JOIN` as `rejoin`, so the Change before it, which names the key, is the answer. Nothing else can send a duplicate `JOIN`.
  - Automatic behaviour is recorded by name, such as `ping-reply`, `lag-check`, `rejoin`, `read`, `ctcp-reply`, `away-restore`, or `nick-regain`. Each name arrives with its behaviour: `away-restore` and `nick-regain` do not exist yet.
- **LOG-6.** Credentials the Daemon holds stay out of the Log, because the Daemon never writes them down ([ADR 0008](adr/0008-credentials-are-held-not-hunted.md)).
  - A Line built from a Credential is sensitive, and is marked so where it is built. Only that code knows where the value went.
  - A sensitive Line is recorded with each value replaced by `<redacted>`, and its Entry is marked redacted with the names of those Credentials, in the order they stand. The names say what was redacted. The text does not, so a Line that holds `<redacted>` for any other reason redacts nothing.
  - The Daemon does not search Lines, reasons, or anything else for the values it holds.
  - The host acts on the Entry as recorded, so replay agrees with what happened.
  - A secret that reaches a Line any other way is recorded like any other Line, and LOG-7 can remove it. Examples are a password typed to a service, pasted into a Message, or sent as a raw Line.
- **LOG-7.** Entries are never edited or deleted by normal operation.
  - An `admin` key can redact an Entry's bytes, for the day a secret gets through. The Entry and its sequence remain, and a Change records who redacted it.
  - Redaction empties the bytes and marks the Entry redacted. Derived rows from it are derived again, so a Message it carried disappears.
  - Only a Line or a Dropped Entry has bytes to redact. The edit and its Change are one transaction, and the Entry names that Change.
  - Every derived table is derived again in that transaction, as a start would, so a restart reads what it leaves (LOG-10). It holds the writer as long as a start's rebuild takes, which suits something done on a rare day.
  - `Standing` keeps what the host knew until the next start, because a Connection under way acted on the Line as it was. A start replays a redacted Line as one with no bytes, which says nothing, so what only it told `Standing` is forgotten, such as a kick, a `JOIN` failure, or a sign of login. What was recorded because of it still stands, such as a `closed` that its `ERROR` gave the reason for. Rows derived from later Entries follow the replay and not `Standing`, so that they are the rows a rebuild writes.
  - Deferred: pruning and retention. Nothing is pruned until we know what a year of Log costs, including large `LIST` replies.
- **LOG-8.** Times are when the Daemon recorded the Entry. Order comes from sequence numbers, never from clocks, because clocks can jump.
  - No wait for a reconnect is ever longer than its own delay from now, so a clock set back cannot keep a Network offline.
  - Deferred: deadlines within a Session still use wall-clock times, so a clock set back by some amount delays noticing a dead Connection by as much.
- **LOG-9.** If the Log cannot be appended to, the Daemon closes its Connections and reports the fault. It never carries on unrecorded, and it resumes on its own once appends succeed.
- **LOG-10.** Projections are disposable. Deleting every derived table and restarting gives identical API results.
  - A fold depends only on Entries and the code. Time-sensitive rules, such as casefolding and Highlights, use what was in force at that Entry.
- **LOG-11.** No read can delay an append. Reads of the Log, such as `/entries`, and later `/search`, `/state`, and Timeline replay, run in a Worker on their own read connection.
  - Reads are paged and have a deadline, because a running query cannot be interrupted, even by terminating its Worker.
  - Search orders by recency by default. Deferred: ranked search, which needs a subprocess if it is to have a hard limit.
  - Deferred: whether the writer should leave the main thread, measured again under real traffic. [`@iirc/log`](../packages/log/README.md#storage-measurements) has the numbers so far.

## Configuration

**Status:** Done, except where an ID says otherwise.

Configuration is what the Owner wants, and the Log's Change Entries record it. Derived state is what is true right now. They stay separate: "autojoin `#foo`" is Configuration, and "we are in `#foo`" is derived.

- **CONF-1.** Configuration is a projection of Change Entries. There is no second source of truth, and its full history is inspectable.
  - Accepting a change and reading a recorded one are separate questions. The Schemas in `@iirc/api` hold every rule a request must meet, so a Frontend can check one before sending it, and a request they pass needs no other check by the Daemon. A bad request is refused with the path of each thing wrong (API-3).
  - A recorded Change is read for what it meant when it was recorded, never against today's rules. A field added since then takes the value that its absence meant, a Tuning number that no longer exists is dropped, and anything else that a rule made since would refuse is folded as it was. So tightening a rule cannot keep the Daemon from starting on a Log it once accepted. Deferred: a version per Change, until a change of meaning needs more than a default.
  - The Daemon will not start on a Change it cannot read at all: one of no kind it knows, such as a newer iirc wrote, or one without the shape its kind always had. It says the Change's sequence and why, because Configuration without that Change would not be what the Owner asked for.
- **CONF-2.** All Configuration can be read and changed through the API while the Daemon runs. A running Session applies a change without a restart where IRC allows it, and otherwise at the next Connection.
  - Applied at once: enabled, Channels, and the `QUIT` reason. A Channel taken off the list is parted if Self is in it, and a newly wanted one is joined. Turning autojoin off parts nothing, because it only stops the Daemon joining.
  - Applied at the next Connection: Ircds, Identity, Credentials, services, connect commands, and Tuning. A change to any of them retries straight away (LIVE-4), so a Network waiting out a backoff picks it up at once.
- **CONF-3.** A Network has a stable ID and a display name, plus an enabled flag and these settings. The ID is up to 32 lowercase letters, digits, and `-`, starting with a letter or digit, and the Owner chooses it. Connect and disconnect set the enabled flag.
  - **Ircds:** an ordered list of host, port, TLS on or off, and an optional pinned key.
  - **Identity:** nick, alternate nicks, username, and realname.
  - **Credentials:** `PASS`, a service password, a TLS client certificate, and SASL details, each by name. _(SASL details M5.)_
  - **Services:** which nicks are services. Defaults to `NickServ`, `ChanServ`, and the usual `*Serv` names.
  - **Connect commands:** Lines to send after registration and before joining, which refer to Credentials by name.
  - **Channels:** name, autojoin, rejoin-on-kick, key by Credential name, and notification level. _(Notification level M4, with VIEW-8.)_
  - **Tuning:** encoding, flood control, liveness, and CTCP replies. Only values the Owner changed are stored, so a new default reaches every Network that never changed it. Each number has bounds and a default, which the API's Schema publishes, and a number left out is checked against the others at its default. _(Done. The encoding is the fallback for decoding (MSG-4), and must be a label the Daemon can decode with. A casemapping the Owner forces is Tuning too (KNOW-3). CTCP replies are a switch each for `VERSION`, `PING`, and `TIME`, the interval per User, and the limit per Network with its window (PROT-3, PROT-4). Each Connection's `attempt` records the whole Tuning, and one recorded before these existed reads them as their defaults. Sending in the encoding waits for SEND-8 in M3: text is sent as UTF-8.)_
- **CONF-4.** The process itself needs only a data directory and a listen address, both given as flags or environment variables. Networks are added through the API, so a fresh Daemon needs no config file.
- **CONF-5.** What the Owner does through the API is intent, and it survives a reconnect. _(Partial: Join and Part are done. Nick and away come with the Self operations in M3.)_
  - Join adds the Channel to Configuration with autojoin on, unless asked not to. Part removes it.
  - Join and Part with no Session still record their Change, and the Channel is joined once the next Session's burst completes. A Join that is not to be remembered needs a Session (API-10).
  - Join clears a kick (LIVE-8), even with no Session.
  - Changing nick updates the configured nick, unless marked temporary. Otherwise nick regain would undo it.
  - Setting away stores the reason, and it is reapplied after `001`.
  - A Channel entered any other way, such as through Raw or an Ircd forcing it, is not remembered.
- **CONF-6.** TOML is a view of Configuration, never its truth ([ADR 0004](adr/0004-configuration-lives-in-the-log.md)).
  - `iirc config export` writes Configuration as TOML, with Credentials as names only.
  - `iirc config import` applies a file as one Change. A file is only ever an input, and the Daemon never watches or rewrites one.
  - A file is the whole Configuration, so importing it removes any Network it leaves out.
  - API keys are not Configuration, and never appear in a file.
  - Both are Frontends of API operations (API-1).

### Credentials

**Status:** Done.

- **CRED-1.** Credentials live outside the Log, behind one `Credentials` service, and Configuration refers to them by name. The service uses the system keyring (`Bun.secrets`) where one is available, and otherwise a file with mode `0600` in the data directory. Status shows which.
  - Once the keyring holds them, a marker file in the data directory says so. A start that finds the marker and no keyring refuses, rather than begin again with none.
  - A start refuses a `credentials.json` looser than `0600`, because other users may already have read it, and says to rotate what it holds. It never loosens or tightens the mode itself.
  - A name is up to 64 lowercase letters, digits, `.`, `_`, and `-`, starting with a letter or digit.
  - Setting or deleting a Credential is a Change that records its name, never its value. It counts as a relevant Change (CONF-2) for every Network whose Connections use it.
  - A Channel key only has the host build its next `JOIN` with the key as it is now.
  - The file is replaced atomically, so a crash leaves the old value or the new one.
  - A write is waited for at most 10 seconds, because a keyring that answered the start can stop answering later, as a locked one does. The caller is then told `CredentialsUnavailable`, and from then on that write has failed, whatever the keyring does. No Change is recorded for it. The write itself is not cancelled, and nothing else is written until it and its undoing end, since a late write of the whole document would replace what a later one kept. Until then, every other Credential write fails at once with `CredentialsUnavailable`, and every other kind of Change goes on.
  - If a write that failed this way lands late, the service writes back the document it holds, which is what it held before that write, before it lets another begin. So the keyring, the live Credentials, and the Log agree, and so does a restart. If the write itself fails, there is nothing to undo. If the undoing fails, Credentials cannot be written until the Daemon restarts, and every write gives `CredentialsUnavailable`, while reads still serve what is held.
  - Configuration may refer to a name that is not set yet, so that a file can be imported first. Such a Network makes no `attempt`, and status lists the missing names.
- **CRED-2.** They are write-only through the API. A Frontend can set, replace, or delete a Credential and can see that it exists, but can never read it.
- **CRED-3.** In memory they stay in `Redacted` values, so they cannot reach logs, traces, errors, or API responses.
- **CRED-4.** A Channel key the Owner gives is a Credential. A key seen on the Network is not ([ADR 0008](adr/0008-credentials-are-held-not-hunted.md)). Even so, derived reads never show a key's value, in a Channel read or in Activity, so that the two agree that it is set, and only `/entries` keeps the Line as the Network said it (LOG-3, API-4).
  - A key given to Join is stored. The Owner replaces or deletes it. Nothing the Network sends changes it.
  - A key is stored under the name the Channel gives it. For a Channel that gives none, the name is `key.` and the first 16 hex digits of the SHA-256 of the Network's ID, a NUL, and the Channel as it is compared, so it is the same however the Owner spells the Channel. The Channel then names it.
  - The Credential is stored, then its Change is recorded, with `by` set to the Join's key name, and only then does the Channel name it.
  - A Join that is not to be remembered stores nothing. Its `JOIN` is sensitive like any other, so the Log has `<redacted>` in place of the key.
  - A `MODE +k` or `-k` is recorded as it arrived, like any other Line. A `JOIN` refused with `475` is a join failure like any other, and the Owner supplies the new key.

## Connecting

**Status:** Done, except CONN-5 (M3).

- **CONN-1.** TLS is the default and verifies the certificate and hostname, sending SNI.
  - Plaintext requires an explicit `tls: false` on that Ircd.
  - Skipping verification requires a pinned key, because a bare "accept anything" option does not exist.
  - A pin is `sha256/` and the base64 SHA-256 of the key's SubjectPublicKeyInfo, as `curl --pinnedpubkey` reads it. A pinned Ircd is verified by its pin alone, so a self-signed certificate works, and the hostname is not checked.
  - A pin that does not match closes the Connection before anything is sent, and the reason gives the pin the Ircd presented, so that the Owner can pin it after checking. A mismatch backs off like any failure.
  - Connecting times out after 15 seconds, and any single write after 10.
- **CONN-2.** Registration sends `PASS` if configured, then `NICK` and `USER`, and finishes on `001`. It times out after 60 seconds, because slow ident and DNS on old Ircds are normal.
- **CONN-3.** The nick in `001` is the truth, and a later `NICK` from the Ircd is too. An Ircd can rename us, for example when services enforce a reserved nick.
- **CONN-4.** A taken or refused nick during registration works through a fixed, finite list.
  - The list is the configured nick, the alternates, then the nick with one, two, and three `_` added. Each is sent as configured, whatever its length, and an Ircd that cannot take one says so.
  - `432`, `433`, `436`, and `437` each move to the next candidate. Before the welcome no `JOIN` has gone out, so a `437` can only be about the nick.
  - When the list runs out, the attempt closes and backs off like any failed Connection, and status says why.
- **CONN-5.** _(M3.)_ Once the burst is complete (CONN-7), the Daemon tries to regain its configured nick.
  - It watches `NICK` and `QUIT`. If it shares no Channel with the holder, it probes with `ISON`, backing off from 15 seconds to 10 minutes.
  - A refused attempt is linked to its cause and is not shown as a failure.
  - It stops and reports on `432`, on a rename by services, or on a refusal that retrying cannot fix, such as Ergo's `force-nick-equals-account`.
- **CONN-6.** After registration the Daemon sends connect commands, then joins.
  - Once the burst is complete (CONN-7), it sends `PRIVMSG <service> :IDENTIFY [account] <password>` if a service password is configured, then each connect command in order, through the interactive lane.
  - A connect command is one Line of text in which `{{name}}` stands for the Credential of that name. A Line with one is sensitive (LOG-6). The causes are `identify` and `connect-command`.
  - The login wait's end is a Deadline Entry. A failure sign, such as `904` or a `NOTICE` from the service saying the password is wrong, also ends it, and status shows the service's words.
  - If a service password was sent, joining waits for login, ending early on a sign such as `900`, `+r` on Self, or a login `NOTICE` from the service.
  - The wait lasts at most 2 seconds, measured from when the last connect command was written. A bare Network offers no reliable signal, so this limit is the floor.
  - `PASS account:password` logs in before the nick is claimed where an Ircd supports it, such as Ergo. It avoids this race, and it is recommended where it works.
- **CONN-7.** The burst is complete on `376`, `422`, or 10 seconds after `001`. Anything that depends on knowing the Network, such as nick regain, background reads, and Lookups, waits for it.

## Staying connected

**Status:** Done. Gaps appear in Timelines once Timelines exist (M4).

- **LIVE-1.** `PING` always gets a `PONG`, in every phase until the Connection starts to close, through the control lane (SEND-1). The `PONG` echoes the token's bytes exactly, whatever their encoding. A closing Connection answers nothing, because a `PONG` could only follow the `QUIT`.
- **LIVE-2.** Silence decides whether a Connection is dead. Any inbound Line proves it is alive. With no inbound Line for 90 seconds, the Daemon declares it dead, so a silently dropped TCP connection is noticed within that time.
- **LIVE-3.** The Daemon sends its own `PING` with a unique token every 60 seconds, busy or not, through the control lane. The round trip is the Network's lag, derived from the Log.
- **LIVE-4.** An unexpected close starts a reconnect.
  - Delays grow from 5 seconds to 5 minutes, with jitter over the upper half of each delay, and reset after a Session has stayed up for 5 minutes.
  - Attempts rotate through the Ircds.
  - Backoff state is derived from Connection Entries, so a crash loop under a service manager cannot hammer a Network.
  - A relevant Change (CONF-2), or an explicit connect, retries straight away, whatever is left of the backoff. The fold knows this from the Change's sequence, so a restart agrees.
- **LIVE-5.** A Network that turns us away backs off like any other failure (LIVE-4), and status shows its own words verbatim. Nothing reads what a Network says to decide how long to wait.
  - An `ERROR` closes the Connection, before `001` or after, and its text is the reason.
  - A numeric such as `463`, `464`, or `465`, or a `FAIL`, closes nothing by itself. The Ircd's own close, its `ERROR`, or the registration deadline ends the Connection.
  - So a Network that bans us is tried again at most every 5 minutes, LIVE-4's longest wait.
- **LIVE-6.** A reconnect is a new Session. Derived Channel state, lag, and every `RPL_ISUPPORT` token are cleared on close, then rebuilt from what the Ircd says, never carried over.
- **LIVE-7.** After the burst, the Daemon rejoins Channels with autojoin on.
  - It batches `JOIN`s by line length, with keyed Channels first (SEND-11).
  - An unsolicited `JOIN` from the Ircd is the truth, so a Network that kept us attached is not rejoined. Ergo's always-on mode does this, and replays those `JOIN`s just after `376`, so rejoining waits 1 second after the burst for them.
  - Each Channel's failure appears in status. `471`, `473`, `474`, `477`, and `437` retry with backoff, and `475` does not.
- **LIVE-8.** A kick wins over autojoin. The Channel is not rejoined, in this Session or the next, until the Owner joins again or the Channel has rejoin-on-kick, which waits 10 seconds. An `INVITE` is recorded and never followed automatically.
- **LIVE-9.** Disconnecting through the API or stopping the Daemon sends `QUIT` with a configured reason through the control lane, waits up to 2 seconds for the queue, and does not reconnect until connected again. Removing a Network does the same.
- **LIVE-10.** Time the Daemon was away from a Network is a Gap. Gaps are visible, derived from Connection and Daemon Entries, and shown in the affected Timelines. The Daemon never implies that nothing happened. _(Gaps are derived and served by `/gaps`. Timelines are M4.)_
  - On a Network that keeps us attached, a Gap means only that we were not listening. Other Users may not have seen us leave.
- **LIVE-11.** A local close stops acting at once, and keeps recording what the Ircd already sent until it hangs up or 5 seconds pass, so that `ERROR` and whatever follows it are not lost. Sends are refused during this time, and status shows the phase once the close is recorded.
  - A stop keeps recording for at most the `QUIT` wait (LIVE-9). A silent Connection and a Log that cannot append do not wait, because there is nothing to read or nowhere to record it.

## Sending

**Status:** SEND-1 to SEND-4 done, and SEND-11 for `JOIN`. The rest M3.

- **SEND-1.** Outbound Lines leave through three lanes in strict priority, and in order within a lane.
  - **Control:** `PONG`, lag `PING`, registration, and `QUIT`. These skip flood control.
  - **Interactive:** anything a Frontend asked for.
  - **Background:** join-time reads, CTCP replies, `ISON`, and rejoining.
- **SEND-2.** Flood control over the interactive and background lanes is a token bucket with a burst of 5 and one Line every 2 seconds. An Owner can tune it per Network.
  - `PENALTY` and similar `RPL_ISUPPORT` hints may tune this later, but nothing depends on them.
- **SEND-3.** The interactive and background lanes each hold at most 1000 Lines. A send beyond that is refused, rather than dropped later.
- **SEND-4.** Nothing outlives its Connection. When a Connection ends, queued Lines become Dropped Entries, and a Message is not sent hours later into a conversation that has moved on. If a Frontend wants to retry, it decides that with full knowledge.
- **SEND-5.** _(M3.)_ A Message that does not fit is split into several Lines, measured in bytes after encoding.
  - The limit is `LINELEN` if advertised and otherwise 512, less the line ending, the command and Target, and the prefix the Ircd will add.
  - That prefix is reckoned from Self's nick plus the worst case for `USERLEN` and `HOSTLEN`, defaulting to 20 and 64. A hidden host can change without notice, and a few spare bytes cost less than silently cut text. Ergo refuses an over-long Message whole by default.
  - If no usable payload remains, the send is refused.
- **SEND-6.** _(M3.)_ Splits prefer word boundaries and always fall on grapheme boundaries.
  - A newline in the text starts a new Line, and empty lines are dropped, because a blank Line is an error on an Ircd.
  - An `action` keeps its CTCP wrapper on every Line.
  - All Lines from one send share a group ID.
- **SEND-7.** _(M3.)_ One send may produce at most 20 Lines, and more than that is refused. The Frontend decides what to do with a large paste.
- **SEND-8.** _(M3.)_ Text is sent as UTF-8 unless the Network sets another encoding. `UTF8ONLY` overrides that setting. Text containing NUL or a bare CR is refused, because an Ircd may disconnect us for it.
- **SEND-9.** _(M3.)_ An error that follows a send is linked to it and shown on it.
  - `401`, `403`, and `404` link by Target. `417` has no Target, so it links to the newest send.
  - On a bare Network this link is a best effort, and the API says so.
  - It can report a refusal but never prove delivery, and a `NOTICE` may be refused silently.
- **SEND-10.** _(M3.)_ A send may carry a request ID. It is stored in the cause and echoed on results, and a repeat with the same ID returns the original result, so a Frontend can retry safely.
- **SEND-11.** Commands that take lists are split like text. `JOIN` splits on commas with keyed Channels first and keys aligned to them, and `ISON` splits on spaces. _(`JOIN` done. `ISON` comes with CONN-5 in M3.)_

## What the Daemon knows

Each item here is derived from the Log.

### Network state

**Status:** M2. Self's nick, the phase, lag, and the casemapping in force are in status. `GET /networks/{id}` gives the rest of KNOW-1 and KNOW-2 as `known`, from `Standing` with its `at`.

- **KNOW-1.** The Network's phase, burst state, the Ircd and TLS details, lag, Self's nick, `user@host`, and modes, and away state. _(Done. Self's `user@host`, modes, and away state are folded in `@iirc/state` and read as `known.self` in `GET /networks/{id}`, beside Self's nick and the phase in `status`, with `at` from the same snapshot. The Ircd and TLS details are in each Connection's Entries.)_
  - Self's mask follows `396`, `900`, `901`, and Self's own `JOIN`.
- **KNOW-2.** Every `RPL_ISUPPORT` token for the current Session, including removals (`-TOKEN`). _(Done in `@iirc/state`, up to 256 tokens, beyond which it says some were dropped. Read as `known.isupport` in `GET /networks/{id}`: every token held by name, with `""` for one sent with no value and absence for one never sent or taken back, and `tokensDropped`.)_
  - Where a token was never sent, these defaults apply: `CASEMAPPING=rfc1459`, `CHANTYPES=#&`, `PREFIX=(ov)@+`, `CHANMODES=beI,k,l`, and `MODES=3`.
  - An empty value differs from an absent token. `PREFIX=` means no prefixes, and `MODES` with no value means no limit.
  - Value escapes such as `\x20` are decoded.
- **KNOW-3.** Nicks and Channel names are compared after casefolding under the mapping in force at that Entry. _(Done. Every mapping and the fallback are in `@iirc/state`, and the Owner's override is Tuning's `casemapping`, which each Connection's `attempt` records and each Session starts from. Status gives the mapping in force, whether the Owner forced it, and the token the Ircd sent that fell back to `ascii`. Each Activity row records the mapping its place was keyed under, so `/activity`'s place filter finds a place's rows across a change of mapping, and a members cursor names its mapping and is refused under another.)_
  - The fold comes from `CASEMAPPING` and `UTF8MAPPING` together, covering `ascii`, `rfc1459`, `rfc1459-strict`, the variant spelling `strict-rfc1459`, and `rfc8265`. Ergo's `precis` mode advertises `CASEMAPPING=ascii` with `UTF8MAPPING=rfc8265`.
  - Anything unrecognised falls back to `ascii`, which splits names rather than merging them, and is reported in status.
  - An Owner can override the mapping, because Ergo's `permissive` mode looks the same as `ascii` on the wire.
  - Display keeps the most recently seen spelling.
  - Deferred: what happens to existing Targets when a Network's mapping changes. Until then, a Target keeps the identity it was given.

### Channels and Users

**Status:** M2. `@iirc/state` folds KNOW-4, KNOW-6, and KNOW-7, and the state KNOW-5, KNOW-8, and KNOW-9 need. The Log attributes KNOW-8. The Daemon asks for KNOW-5 and KNOW-6 through `readPlan` in `@iirc/session`. A Channel is read through `GET /networks/{id}/targets/{target}`, and a partner in M4.

- **KNOW-4.** For each Channel: topic, who set it and when, modes, creation time, and members with their prefixes, ranked by `PREFIX`. _(Done in `@iirc/state`, which holds only what `NAMES` and `MODE` show, so without `multi-prefix` a member can be short of a prefix. Read through `GET /networks/{id}/targets/{target}`, from `Standing` with `at` from the same snapshot, with members in pages of at most 1000 by cursor, each member's prefix letters ranked and their symbols, and the key shown as set and never with its value (CRED-4).)_
- **KNOW-5.** Membership and topic come from what `JOIN` already returns. _(Done. The atomic replacement, the rule for Channels Self is not in, and a change for each removed prefix are in `@iirc/state`, and the asking is `readPlan` in `@iirc/session`. The Channel read says whether members or modes are uncertain.)_
  - The Daemon sends only `MODE`, and `WHO` for `user@host`, through the background lane. A large Channel can delay these, and they never delay a Message.
  - One read waits for a reply at a time on each Network. A read with no reply is asked again after 60 seconds, doubling, three times in all in a Session, and an error naming the Channel answers it at once. A Channel of more than 1000 members gets no `WHO`, because each member costs a Line.
  - `353` up to `366` is an atomic replacement of the member list.
  - `332`, `324`, and `353` never change state for a Channel Self is not in.
  - Without `multi-prefix`, a member with `@+` shows only `@`, so removing a prefix mode schedules a debounced `NAMES`, 2 seconds after the last removal and at most 10 seconds after the first.
- **KNOW-6.** `MODE` Lines are parsed using `PREFIX` first and then `CHANMODES`, so that list, parameterised, and flag modes are told apart. _(Done. `@iirc/state` marks a Channel uncertain, and `readPlan` reads its modes with `MODE` and its members with `NAMES` until a `324` and a `366` settle them. A Channel's key is shown as set and never with its value in every derived read, in Activity's `mode` details and in a `324` or `MODE` kept as a `line`, as in the Channel read (CRED-4). A `MODE` that did not add up cannot say which parameter is the key, so it keeps its letters and no parameters.)_
  - A letter the Network never advertised takes no argument. If the arguments then fail to add up, the `MODE` is kept raw, the Channel is marked uncertain, and its modes and members are read again.
  - A key shown as `*` is hidden and is not stored.
- **KNOW-7.** A User's nick, `user@host`, and realname are remembered as seen, and away state where known. _(Folded in `@iirc/state` from `JOIN`, `PRIVMSG`, and `NOTICE` sources, `301`, `311`, and `352`, within a bound that forgets the longest unseen. Asked for with `WHO`. A Channel's members carry what was seen of them in the Channel read. A partner's details are M4.)_
- **KNOW-8.** `QUIT` and `NICK` Lines name no Channel. They are attributed to every Channel the User shared with Self at that moment, which only a fold over the Log can determine. A `NICK` or `QUIT` from a Direct Message partner also appears in that Timeline. _(Done in the Log's `activity` table: a row in each Channel `@iirc/state` names as shared, those in a `NAMES` reply under way included, and in each partner's Timeline, where a partner is anyone with a Direct Message place in the Log, this Session or earlier, held in two bounded generations. A partner's new nick has no Timeline until something is placed there. A `QUIT` or `NICK` that concerns neither is on the Network's Timeline. Read through `/activity`.)_
- **KNOW-9.** A `470` forward puts us in a different Channel from the one requested. It is reported against the configured name, so autojoin does not look like it failed. _(`@iirc/state` names both Channels in a change. Reporting is a later step.)_

## Messages and Activity

**Status:** Done. The Log derives Messages into `messages` and Activity into `activity`, each with its place, and `/messages` and `/activity` serve them, with participant text both raw and as spans.

- **MSG-1.** `PRIVMSG` and `NOTICE` become Messages of kind `PRIVMSG`, `NOTICE`, or `ACTION`, and the text of an `ACTION` is the action itself. Self's Messages come from outbound Lines, because the floor has no `echo-message`. _(Done, in `/messages` from API version 2.)_
- **MSG-2.** Each inbound Line belongs to one place, decided in this order:
  - Anything before `001`, with Target `*` or `AUTH`, or with no source or a source that is not `nick!user@host`, goes to the Network's Timeline. This keeps Ircd notices from becoming Direct Messages and Highlights.
  - A Channel Target goes to that Channel. A `STATUSMSG` prefix such as `@#chan` belongs to `#chan`, and stays as an attribute.
  - A `$` mask goes to the Network's Timeline.
  - An inbound Line sourced from Self is a Self Message.
  - Any other Target is a Direct Message from its sender, even if the Target does not match Self.
  - _(Done in `@iirc/state/place` for every Line with a Target, from the state before it, and Self's outbound Messages are placed by their Target. A place is keyed by its casefolded name and keeps its spelling. `/messages` gives each Message's place and `STATUSMSG` prefix.)_
- **MSG-3.** Text keeps its IRC formatting codes.
  - The API offers both the raw text and a parsed form with those codes as spans, so that a Frontend never has to interpret them. Both are data and never markup.
  - Highlights and search run on text with the codes stripped.
  - _(Done. A Message has `spans` beside `text`, and Activity's topics, reasons, CTCP and DCC arguments, and standard replies' descriptions, and a Channel's topic, are `{ text, spans }`, from `parseFormatting`. A span holds only the styles that are on. The Log's reader parses them on its Worker and counts each span toward its page bound (LOG-11). Highlights and search are M4.)_
- **MSG-4.** Inbound bytes decode as UTF-8, then through the Network's configured fallback encoding, then Latin-1. Decoding never fails.
  - The fallback is any WHATWG `TextDecoder` label.
  - _(Done. Latin-1 is ISO-8859-1, one character per byte, and not WHATWG's `latin1`, which is windows-1252. A Connection decodes with the fallback its `attempt` recorded, in `Standing`, the machine, the derived tables, and `/entries` alike, so a rebuild gives the same text as live did after the Owner changes the encoding. A label refused by the API's Schema never reaches a Connection, and one recorded that a later runtime cannot read gives no fallback.)_
- **MSG-5.** Activity covers joins, parts, quits, kicks, nick changes, topic changes, mode changes, invites, and CTCP requests. _(Done in the Log's `activity` table, derived from `@iirc/state`'s changes, with DCC offers, standard replies, and unknown Lines as kinds of their own. Read through `GET /activity`, by one opaque cursor such as `123` or `123.4`, with `network` and `place` filters, each row with its sequence and typed details, and each page with the cursor after it.)_
- **MSG-6.** Lines with no Channel or User to belong to, such as the MOTD, `WALLOPS`, and most numerics, go to the Network's Timeline. _(Done: every inbound Line that is no Message and no other Activity is a `line`, or an `unknown` for a command not handled, on the Network's Timeline, one row per Line. Every numeric is one. `PING` and `PONG`, and Lines that do not parse or were cut, are in `/entries` only.)_

## Timelines and attention

**Status:** M4.

- **VIEW-1.** A Timeline is the ordered Messages and Activity of one Channel, one Direct Message partner, or one Network, paged in either direction. Its order is a derived position, and it matches sequence order until history is filled in (see [Filling Gaps](#filling-gaps)).
- **VIEW-2.** Each Network lists its Targets: Channels joined or once joined and Users exchanged Direct Messages with.
  - Each has a stable ID, its latest Entry, and unread counts by class (VIEW-9). API routes use the ID, because a raw `#` in a path is awkward and names can change.
  - A Direct Message's partner is the other participant, as compared under KNOW-3.
  - When a partner's `NICK` is seen, the old and new names stay one Target. A nick reused later by someone else, with no `NICK` seen, is a new Target.
  - Hidden, pinned, and order are Configuration, so devices agree.
- **VIEW-3.** A Read Marker is a per-Target sequence number, shared by all Frontends, so reading on a phone clears the desktop.
  - It moves forward unless a Frontend explicitly rewinds it, and it is clamped to the latest Entry.
  - A request that does not move it writes no Change, and every request returns the effective value.
- **VIEW-4.** A Highlight is a Message that mentions Self's nick or configured nick as a whole word, or matches a configured keyword, under casefolding.
  - `-`, `_`, and `|` are part of a word, and text inside a URL does not count.
  - Every Direct Message received is one, except from a configured service.
  - Self's own Messages never are.
  - It is decided with the nick and keywords in force at that Entry, so changing keywords does not rewrite the past.
- **VIEW-5.** Ignoring is a filter over projections, set by `nick!user@host` mask and optionally scoped to a Network or Channel.
  - Ignored Lines stay in the Log, and removing the ignore brings them back.
  - Membership still updates for ignored Users, ignored Users get no CTCP reply, and Self cannot be ignored.
- **VIEW-6.** Full-text search covers Messages, filtered by Network, Target, sender, and time range.
- **VIEW-7.** Past state can be read at any sequence: what were the members of `#foo` at Entry 80412? This is the debugging tool that the Log makes possible.
  - Deferred: snapshots to speed this up. We add them when a fold is too slow.
- **VIEW-8.** Each Target has a notification level: `none`, `highlight`, `message`, or `all`.
- **VIEW-9.** Every Message and Activity has a derived class: `low`, `message`, `direct`, or `highlight`. Activity is always `low` and never counts as unread.
- **VIEW-10.** Hiding join and part noise is a Frontend's policy, and the Daemon supplies the facts. Each join, part, and quit carries the sequence of that User's last Message in the Channel. No filter state is stored, because a mutable flag would break LOG-10 and VIEW-7.

## Frontend storage

**Status:** M4.

Frontends can keep small values in the Daemon, so that a theme or layout follows the Owner across devices.

- **STORE-1.** Storage is key-value, grouped by a namespace each Frontend chooses, such as `web`. Values are opaque JSON that the Daemon never interprets.
- **STORE-2.** A write is a Change Entry, so storage is a projection like everything else, and it rebuilds and has history.
  - A value is at most 64 KB.
  - Because writes stay in the Log, this is for settings, not for something that changes on every keystroke.
- **STORE-3.** Writes reach other Frontends through `/stream`. The last write wins, unless a write carries the `at` it read, in which case it is refused if the value has since changed.
- **STORE-4.** Anything the Daemon acts on stays in Configuration, such as notification levels, ignores, and pinned Targets. Storage is only for what Frontends alone read.
- **STORE-5.** Storage is not for secrets. Any `read` key can see it.

## Lookups

**Status:** M3.

A Lookup asks the Network something and collects a reply spanning several Lines. Without `labeled-response`, nothing ties a reply to its request, so a table describes each kind.

- **LOOK-1.** Lookups cover `WHOIS`, `WHOWAS`, `WHO`, `NAMES`, `LIST`, `MOTD`, `LUSERS`, `VERSION`, `TIME`, `ADMIN`, `INFO`, `LINKS`, `USERHOST`, `ISON`, `MODE` reads, and the ban, except, and invite lists.
- **LOOK-2.** Each returns a typed result and the sequence range of the Lines that produced it.
- **LOOK-3.** Each kind has a table record: the numerics that start it, end it, or may follow it, and which parameter must equal its casefolded argument.
  - `263`, `421`, and `461` end a Lookup too, matched by parameter.
  - After the end, it waits briefly for numerics that can trail, such as `329` and `333`.
  - A reply that matches nothing is ignored by Lookups and stays an ordinary Line.
- **LOOK-4.** Lookups run first in, first out per Network, and only one at a time when they could share an error numeric and an argument, across kinds and against sends. `401` is valid for `WHOIS`, `WHO`, `USERHOST`, and `PRIVMSG`.
- **LOOK-5.** The timer of 30 seconds starts at write, not at enqueue, and each matching reply resets it, so a long `LIST` survives.
  - A Lookup that times out, or whose Connection closes, reports what it collected.
  - A queued Lookup is cancelled if its caller leaves.
- **LOOK-6.** The Daemon's own `WHO`, `MODE`, and `ISON`, and any matching Line sent through Raw, pass through the same correlator, so that they cannot land in someone else's result.
- **LOOK-7.** Replies still appear in the Log and Timelines as ordinary Lines, whoever asked. A Lookup is a view, not a separate path.

## Protocol behaviour

**Status:** Done. Every Line is recorded, whatever its command. PROT-1, PROT-2, PROT-5, and PROT-6 are derived as Activity in the Log. PROT-3 and PROT-4 are decided by `ctcpAnswer` in `@iirc/session`, from `Standing`.

- **PROT-1.** The Daemon handles `PRIVMSG`, `NOTICE`, `JOIN`, `PART`, `KICK`, `QUIT`, `NICK`, `TOPIC`, `MODE`, `INVITE`, `AWAY`, `ERROR`, `PING`, `PONG`, and all numerics in the Modern client protocol. Any other command is still recorded, and appears in the Network's Timeline as an unknown Line. _(Done in the Log's `activity` table, as kind `unknown`.)_
- **PROT-2.** CTCP `ACTION` is a Message. Other CTCP requests are Activity. _(Done. A CTCP in a `NOTICE` is Activity too, marked a reply. Self's own CTCP requests are no Message and no Activity, and stay in `/entries`.)_
- **PROT-3.** The Daemon answers CTCP `VERSION` with `iirc` and echoes the sender's argument to CTCP `PING`, and answers nothing else by default. `TIME` reveals a timezone, so it is opt-in. _(Done. Each is a switch in Tuning. `TIME` stays opt-in, and gives the time in UTC, as ISO 8601 to the second with `Z`, from the Entry's time, so it reveals the clock and no timezone, and a replay says the same. A `PING` argument over 128 bytes gets no reply. Only a `PRIVMSG` from a `nick!user@host` other than Self, after the welcome, and not to `*`, `AUTH`, or a `$` mask, is answered, and only to a sender whose nick parses as a User's, never as a Channel, a `STATUSMSG` Target, or a mask.)_
- **PROT-4.** CTCP replies go out as `NOTICE`, at most one per User per 10 seconds and 5 per minute per Network. No automatic reply is ever sent in response to a `NOTICE`. _(Done, through the background lane with the cause `ctcp-reply`. The limits are a window in `Standing`, folded from the Log: each reply counts from when it is decided and while it is pending, then from when it is recorded as sent, and not at all once Dropped. One not written within the Network's window of being decided is Dropped as it reaches the head of the lane, so no more than the limit leave in any window. Any other CTCP `NOTICE` Self sends counts once recorded, so a restart or a reconnect resets nothing. A User is keyed under the mapping in force, and is let go of only once their interval has run out. A request past a limit gets nothing, and only its Line and Activity row record it.)_
- **PROT-5.** DCC requests are recorded and never acted on. _(Done: a `dcc` Activity with its subcommand and raw arguments, and nothing reads it to act.)_
- **PROT-6.** `FAIL`, `WARN`, and `NOTE` are parsed on every Network, whatever was negotiated. Ergo sends them unconditionally. _(Done: a `reply` Activity on the Network's Timeline, by shape alone. One that does not parse is a `line`.)_

### Hostile input

**Status:** HOST-1 to HOST-4 done. HOST-5 done for Networks and in-process watchers, and for Frontends with `/stream` (M4).

- **HOST-1.** No sequence of bytes from an Ircd can close a Session, stop the Daemon, or lose a Line. Unparseable input is recorded with its reason.
- **HOST-2.** Frames longer than 8704 bytes are cut and marked, not buffered without limit.
- **HOST-3.** Nothing a participant sends can make the Daemon do something beyond what this document names. A CTCP flood is rate limited, and a Message is never interpreted as an instruction. _(Done for what exists. What a participant can draw from the Daemon is a CTCP reply, within PROT-4's limits, and a read of a Channel, within KNOW-5's. DCC is never acted on (PROT-5).)_
- **HOST-4.** The API marks all participant-supplied text as untrusted. Agents must treat it as data, because anyone on a Network can write text that an agent will read. _(Done. Every such field is `UntrustedText` in `@iirc/api`, one OpenAPI component that says it is data and never instructions, and carries `x-iirc-untrusted: true` in `openApiDocument()`: Messages, Activity, topics, nicks, Channel names, `user@host`, realnames, `RPL_ISUPPORT` values, an Ircd's words in `/status`, Gaps' and Dropped Entries' reasons, and the decoded text in `/entries`. It is a plain string at runtime. A test walks the document for a list of known participant fields.)_
- **HOST-5.** One Network cannot starve another, and no Frontend can stall a Session (LOG-11). A slow reader is disconnected, and resumes from its cursor or gets `resync` (API-6).
  - The same holds in the process. Anything that watches Entries as they commit cannot hold up a commit. A watcher that falls behind is told which run of sequences it missed, and is never left to miss them silently.

## API

**Status:** Done for the surfaces that exist, which the tables below mark. API-6 M4. API-7 and API-8 M3.

`HttpApi` in `@iirc/api` defines the contract, and implementations follow it. SSE and WebSocket are adapters over that contract, and SSE comes first. All of it is in the published OpenAPI document, except the WebSocket route, which shares `/stream`'s event Schema. All paths below sit under `/api`.

- **API-1.** Anything the Daemon can do is an API operation. No ability exists only as a flag, a file, or a console command. The first key is the one exception (AUTH-4).
- **API-2.** A Frontend never has to parse IRC. Every derived item carries the sequence of the Entry behind it, so that it can always be traced to bytes.
- **API-3.** Errors are typed and tagged. Operations distinguish a bad request, no Session, a full queue, a Line lost to its Connection, a failed write, a Log that is down, and a Network refusal.
- **API-4.** Line bytes, in a Line or a Dropped Entry, are returned as base64 beside the decoded text, because hostile bytes must survive JSON.
- **API-5.** `/status` reports the API version, and responses are compressed when asked. _(The version is done. Compression M4.)_

### Reading

| Surface | Purpose | Status |
| --- | --- | --- |
| `GET /bootstrap` | Every Target, the latest items, and members, with one `at` | M4 |
| `GET /entries` | The Log, by cursor, with filters by Network and kind | Done |
| `GET /messages` | Messages, by cursor, each with the sequence of its Line | Done |
| `GET /activity` | Activity, by cursor, with filters by Network and place | Done |
| `GET /gaps` | Gaps, by cursor, optionally for one Network | Done |
| `GET /stream` | Replay from a cursor, then live, with no gap or duplicate at the join | M4 |
| `GET /status` | The Daemon and all Networks at a glance | Done |
| `GET /networks`, `GET /networks/{id}` | Configuration, with Credentials as names only, and derived state | Done |
| `GET /configuration` | All Configuration at once, as `iirc config export` reads it | Done |
| `GET /networks/{id}/targets` | Targets, with unread counts by class | M4 |
| `GET /networks/{id}/targets/{target}` | Topic, modes, and members of a Channel, or a partner's details | Done for a Channel. M4 for a partner |
| `GET /networks/{id}/targets/{target}/timeline` | A Timeline, paged in either direction | M4 |
| `GET /search` | Full-text search | M4 |
| `GET /storage/{namespace}` | A Frontend's stored values | M4 |
| `GET /state?at={sequence}` | Derived state as it was at that Entry | M4 |
| `GET /health` | Unauthenticated liveness for service managers | Done |
| `GET /metrics` | Metrics for scraping | M4 |

- **API-6.** `/stream` is the only thing a Frontend needs to stay current.
  - It carries Entries, the Messages and Activity derived from them, and typed changes to derived state, such as members, topic, modes, counts, Read Markers, phase, lag, Configuration, and stored values, all under the Entry's sequence as the Server-Sent Event ID.
  - Reconnecting with `Last-Event-ID` resumes exactly.
  - Every derived read returns `at`, the sequence it reflects. Starting `/stream` from that value leaves no gap.
  - It filters by Network and kind, and offers a notifications-only mode.
  - A cursor too far behind receives `resync`, and the Frontend calls `/bootstrap`. A phone back after a month must not replay the Log.
  - A quiet stream sends typed heartbeats, so a dead reader is noticed.

### Acting

| Operation | Effect | Status |
| --- | --- | --- |
| Send | A Message of kind `privmsg`, `notice`, or `action`, or a CTCP request | M3 |
| Thin Send | `POST /messages`: one `PRIVMSG` to one Target, until Send replaces it | Done |
| Membership | Join with an optional key, part, invite, kick | Join and part done. Invite and kick M3 |
| Channel | Set a topic, change modes in `MODES`-sized batches | M3 |
| Self | Change nick, set or clear away, set user modes, `OPER` | M3 |
| Lookups | As in [Lookups](#lookups) | M3 |
| Network | Add, change, remove, connect, disconnect | Done |
| Configuration | Replace all of it as one Change (CONF-6) | Done |
| Raw | Send any Line the library can construct safely | M3 |
| Marking | Move a Read Marker, set ignores, Highlight keywords, and levels | M4 |
| Storage | Set and delete a Frontend's stored values | M4 |
| Credentials | Set, replace, and delete | Done |
| Redaction | Remove an Entry's bytes (LOG-7) | Done |
| Backup | Write a copy of the Log to `backups/` (RUN-2) | Done |
| Keys | Create, list, and revoke API keys | Done |

- **API-7.** _(M3.)_ Convenience such as `/op` or `/ban` is a Frontend's job, built on the modes operation. The API stays small.
- **API-8.** _(M3.)_ A raw Line changes nothing directly, and derived state still follows what the Ircd says.
- **API-9.** An operation returns once its Lines are written or refused, and gives the sequences it produced. Send times out with the Lines' status if the queue is slow.
  - An operation that recorded a Change always succeeds with that Change's sequence, and a Line it then could not send is reported beside it as `failed`, with its typed error. A Line that would change nothing, such as `JOIN` for a Channel Self is in, is `skipped` with its reason.
- **API-10.** Acting on a Network with no Session returns a typed error at once. Nothing is held for later (SEND-4).

### Access

**Status:** AUTH-1 to AUTH-5 done. AUTH-6's rule that keys travel in headers is done, and its WebSocket part is M4. AUTH-7 M4. [ADR 0006](adr/0006-proportionate-security.md) says how far security goes.

- **AUTH-1.** Every API call needs a key except `/health`. Loopback gets no exemption, because every action needs a named cause (LOG-5).
- **AUTH-2.** Keys are named, stored hashed, shown once, compared in constant time, and revocable. The name appears in the cause of what they do (LOG-5), so an agent's actions can be told from the Owner's.
  - A key is `iirc_` and 32 random bytes in base64url. Creating or revoking one is a Change that records its name, scope, and SHA-256, never the key.
  - A missing or unknown key gets `401`, and a key without the scope gets `403`.
- **AUTH-3.** A key has one of three scopes:
  - `read` sees the Log and derived state.
  - `chat` adds Send, membership, Channel, Self, Lookups, Marking, and Storage.
  - `admin` adds Network, Raw, Credentials, Redaction, and Keys.
  - Deferred: whether `OPER` moves to `admin`.
- **AUTH-4.** The first key comes from a local command, `iirc key create`, since a fresh Daemon has no way to authenticate anyone.
  - It appends to the Log itself, so it needs the Daemon stopped: the data directory's lock (RUN-4) admits one process, and the command says so rather than wait. Every later key comes from the API.
- **AUTH-5.** The API listens on loopback by default. It does not terminate TLS, and remote access goes through a tailnet or reverse proxy. Request headers and bodies have size limits.
- **AUTH-6.** Keys travel only in headers, never in a URL.
  - A browser cannot set `Authorization` on `EventSource` or a WebSocket. SSE from a browser therefore uses `fetch`, which can.
  - The WebSocket adapter uses the `Sec-WebSocket-Protocol` bearer pattern, offering `iirc.v1` first so that the key is never echoed back.
- **AUTH-7.** A browser never holds a key in script. Networks deliver hostile text to the page, so a key in `localStorage` would be exposed to any rendering bug.
  - The web frontend is always served from the same origin as the API, in every deployment shape ([ADR 0007](adr/0007-one-binary-shapes-by-argument.md)).
  - A key is exchanged once for an `HttpOnly`, `SameSite=Strict` cookie, and state-changing requests also check `Origin`.

## Observability

**Status:** OBS-4 done. OBS-1 in part: status says why a Network closed, when it next tries, and how its login went, and Dropped Entries say why. OBS-2 and OBS-3 M4.

- **OBS-1.** Everything in this document that the Daemon decides is explainable from the API: why it reconnected, why it picked that nick, why a Line was dropped. No knowledge exists only in a process log.
- **OBS-2.** Spans, logs, and metrics are emitted through Effect and can be exported over OpenTelemetry. No Credential or Message text appears in them.
- **OBS-3.** Metrics include Lines in and out, depth of each lane, Dropped Lines, lag, reconnects, Log append latency, and Log size.
- **OBS-4.** The lifecycle machine's state for each Network is part of status.

## Running it

**Status:** Done. Only the stand-alone Daemon shape exists so far.

- **RUN-1.** `bun build --compile` produces one executable, `iirc`, with a systemd user service that restarts it on failure. Arguments choose the deployment shape ([ADR 0007](adr/0007-one-binary-shapes-by-argument.md)).
  - The service is a template, `iirc@.service`, so one machine can run several Daemons, as the soak test does. Instance `x` keeps its data in `~/.local/state/iirc/x` and reads its environment, such as `IIRC_HTTP_PORT`, from `~/.config/iirc/x.env`.
  - Deferred: an RPM, once the executable is stable.
- **RUN-2.** Backup uses `VACUUM INTO` from a read connection, so it is safe while running. Credentials are not part of a backup, wherever they are held.
  - An `admin` key asks for one through the API, and it is written to `backups/` in the data directory, never to a path a request names.
- **RUN-3.** A restart is safe at any moment. The new process starts new Sessions, records the Gap, and resumes every Frontend from its cursor.
  - `SIGTERM` and `SIGINT` are a clean stop: the Network goes first (LIVE-9), then a Daemon `stopped` Entry, then the Log, and the process exits 0.
  - A stop waits for a Change under way, which is at most 10 seconds when that Change is waiting on a keyring that has stopped answering (CRED-1). It then closes the Networks as usual.
- **RUN-4.** The Daemon takes an exclusive lock on its data directory, so that two processes can never hold Sessions for one Log. The lock releases itself if the process is killed.
- **RUN-5.** Migrations run at startup, after an automatic backup, and never rewrite stored Line bytes. A Log newer than the binary is refused.

## Proof

**Status:** PROOF-1 and PROOF-4 done. PROOF-2 in part: conformance vectors cover parsing, and fuzzing is not built. PROOF-3 in part: ngircd passes, a netsplit included, and Ergo has not run. PROOF-5 running since 2026-11-04 ([roadmap](roadmap.md#the-soak-test)).

- **PROOF-1.** Every requirement has a test that cites its ID where a test is possible. Scripted Ircds cover failure modes that a real Ircd will not produce on demand, and clocks are injected so timer behaviour is tested exactly.
- **PROOF-2.** `testdata` conformance vectors cover the library. Protocol parsing is fuzzed with random bytes.
- **PROOF-3.** Before a release, the Daemon passes against each real Ircd in the matrix: ngircd as the floor, and Ergo under `default.yaml`, `traditional.yaml`, and `precis` casemapping.
  - `bun run proof:floor` covers ngircd. It starts private ones on free loopback ports, makes the first key with `iirc key create`, and drives the built binary only through its API, signals, `iirc config`, and raw IRC clients.
  - It checks LIVE-2 to LIVE-10, CONN-3, CONN-4, and SEND-2.
  - It checks two Networks on two Ircds, where one going down leaves the other's Sends flowing (HOST-5, CONF-3), and Join and Part, seen live and kept across a restart (CONF-2, CONF-5).
  - It checks export and import of Configuration, including a refused file (CONF-6), and keys by scope and after revoking (AUTH-1 to AUTH-3).
  - It checks TLS pinning against a self-signed certificate (CONN-1). Against an ngircd built without TLS it skips that check and says so.
  - It checks `PASS` (CONN-2), a service login that waits out the login wait and a connect command (CONN-6), and a Channel key from a Join, kept across a restart and unchanged by a `MODE +k` (CRED-4). It checks that a missing Credential holds every `attempt` back until it is set (CRED-1), and that a backup passes `quick_check` (RUN-2). No Credential's value is in the Log's files or the backup, except in a Line in which someone else said it, which is recorded as they said it (LOG-6).
    - For a Channel key, the Owner's and one seen in a `MODE +k`, no outbound Line, Dropped Entry, or Change holds it. On disk it may be only in the `bytes` of an inbound `MODE` that sets or unsets it, or of the `324` that answers the Daemon's own `MODE` read (ADR 0008). No derived table holds it, `activity` included, because a derived read shows a key as set and never with its value (CRED-4, KNOW-6). Once the last Daemon has stopped, three checks are made. Every value SQLite reads back, in every table, column, and row, that holds the key must be `entries.bytes` of such a Line, and one in any other table or column fails the proof. In a `VACUUM INTO` copy, which holds the live records with no WAL and no free space, every occurrence must lie inside a byte-for-byte copy of such a `bytes` value, and every one must be there. And in `iirc.sqlite`, its WAL, and any backup, every occurrence must also lie inside a byte-for-byte copy of one. Occurrences are located rather than counted, because no count is exact: a WAL keeps a copy of each version of a page.
  - It checks a TLS client certificate by the fingerprint ngircd says it saw. Against an ngircd without TLS, or one that never says, it skips that check and says so.
  - It checks a netsplit and a reconnect on two ngircds linked on loopback (KNOW-4 to KNOW-6, KNOW-8, MSG-5, LIVE-6). The Daemon is on one, with Users on both, `@`, `@+`, and `+` among them, and `+ntlk`, which it joins with the key (CRED-4). An IRC operator splits the link with `DISCONNECT` and joins it again with `CONNECT`, and the Daemon then disconnects and connects. Each time, and after a `-o` that only a debounced `NAMES` can correct, a raw client's `NAMES` and `MODE` must equal the Channel read, paged through, member for member with the highest prefix, and mode for mode with the key as set only. "Settled" comes from the API: the Daemon has recorded a Message the raw client sent after what it saw, nothing is uncertain, every read it sent is answered, and two reads give the same `at`. Each User on the far side has one `QUIT` in the Channel's Activity, the rejoin burst brings back every member and its highest prefix as `NAMES` shows it, and the new Session carries over none of Self's. Against an ngircd that cannot link, it skips that check and says so.
- **PROOF-4.** Kill tests send `SIGKILL` during traffic, then check that no recorded Line is missing or duplicated and that projections rebuild identically. This does not test power loss, which rests on `synchronous=FULL`.
- **PROOF-5.** Soak test: two Daemons share a Channel on the floor Ircd, one sends a counted Message each minute, and the other checks that none are missing. The first proof in the vision is 30 days of this passing on a real Network as well, with every Gap explained.
  - `iirc-soak` ([`apps/soak`](../apps/soak/README.md)) is a Frontend of both Daemons that uses only the API, and [the soak guide](guides/soak.md) says how it runs. `iirc-soak send` sends `soak <minute> <millis>` each minute, where `<millis>` is the epoch millisecond of the run and `<minute>` is its Unix minute, so that each Message has an identity of its own, and `iirc-soak check` reads both Logs in full each hour and keeps no state.
  - A Message that is sent and not received is judged by its own identity, and is explained if the sender's Log shows that Message Dropped, or if a Gap on either Daemon's Network covers the time it was sent. A Gap's window runs from the last inbound Line the Daemon recorded before it began, to the echo of the Daemon's own `JOIN` of the Target after it ended. Nothing pads it, and a window whose end is not yet in the Log is open.
  - Names are compared by the `CASEMAPPING` the Connection was told (KNOW-3). A Message sent or received more than once, a Message received that was never sent, and any stretch of more than 10 minutes in which the sender did not run all fail the check. The last is derived from the minutes, so it is never forgotten. Each Log is read from one moment, up to the newest sequence read first, so that a Gap recorded during the read is left for the next run.

## IRCv3 enhancements

**Status:** M5. [`roadmap.md`](roadmap.md#ircv3-enhancements) lists the capabilities and mechanisms each improves on.

Each of these is detected, never assumed. A Network setting turns them all off, and the floor test matrix runs with it off.

### Negotiation

- **CAP-1.** `CAP LS 302` goes before `NICK` and `USER`. An Ircd without capabilities ignores it or rejects it harmlessly, and registration carries on.
- **CAP-2.** Registration holds until `CAP END`, so negotiation has its own short timer.
- **CAP-3.** Only an exact allowlist is requested. One unknown name refuses a whole `REQ`, and Ergo disconnects anyone who requests its trap capability, so "request everything" is not an option.
- **CAP-4.** Multi-line `LS` replies are collected, `NAK` retries each capability on its own, and `CAP NEW` and `CAP DEL` update live state.

### Deduplication

`msgid` is neither per-Line nor globally unique. One `QUIT` uses the same ID in every Channel, and a split Message carries it only on its first Line.

- **DEDUP-1.** Deduplication is a projection keyed by Network, casefolded Target, and `msgid`. The Log keeps every Line.
- **DEDUP-2.** An inbound Line from Self is matched against our own outbound Lines, because other sessions of an account can receive our sends without `echo-message`.

### Filling Gaps

A filled Entry always has a later sequence than the live Lines around it, so Timelines cannot simply sort by sequence.

- **FILL-1.** A Timeline orders items by a derived position: the Gap they fill, then their `server-time`, then their sequence. Sequence stays the order of `/entries` and `/stream`.
- **FILL-2.** Lines inside a `chathistory` batch never affect derived Network or Channel state. A replayed `JOIN` is history, not membership.
- **FILL-3.** Synthetic Lines are not Messages, such as Ergo's `HistServ` Lines, whose `msgid` starts with `_`. `draft/event-playback` avoids most of them.
- **FILL-4.** Filling runs after `JOIN` completes, with a slight time overlap, and pages until `draft/chathistory-end` or a short page.
- **FILL-5.** A Gap closes only if the fill overlaps something already logged, otherwise the remainder stays visible. An empty reply proves nothing, because history is limited on Ergo and a stale `msgid` returns nothing without an error.
