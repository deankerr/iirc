# Daemon specification

This document says what the Daemon must do. [`VISION.md`](../../VISION.md) says why, and [`GLOSSARY.md`](../../GLOSSARY.md) defines the words. The floor in [ADR 0001](../adr/0001-bare-irc-is-the-floor.md) applies throughout: every requirement here works on a Network with no IRCv3, unless it appears in [IRCv3 enhancements](#ircv3-enhancements).

The first slice was a spike and binds nothing here. This spec draws on the protocol documents and on what Ergo, soju, and WeeChat show about real Networks. [`architecture.md`](architecture.md) sketches how it is built.

Reading this document:

- Requirements have stable IDs so that tests and commits can cite them.
- Numbers are defaults that the Owner can change per Network.
- A ❓ bullet is an open question that needs an answer from the Owner.
- A "Deferred" bullet is a minor decision that will be easier once the foundation exists.

Anything another project would want, such as parsing `RPL_ISUPPORT`, casefolding, mode tracking, Message splitting, flood control, or the reconnect policy, belongs in the library. The Daemon adds only durability, Configuration, and the API.

## Model

The Daemon runs one Log and any number of Networks. Everything durable is an Entry in the Log. Everything else is derived from it.

```text
Ircd <-> Connection <-> Session ---> Log ---> projections ---> API ---> Frontends
                           ^                                    |
                           +---------- operations --------------+
```

- **LOG-1.** There is one Log per Daemon. Sequence numbers are global, start at 1, have no gaps, and are never reused, so one cursor can resume everything.
- **LOG-2.** An Entry is one of:
  - **Line:** one Line in either direction, with its Network, its Connection, and a cause if outbound.
  - **Connection:** an attempt, opening, closing, or close, with the Ircd, TLS details, and reason. An attempt names the nicks it will try, how many Lines its login sequence holds, and which nicks are services (CONN-6). An opening over TLS records the protocol, the cipher, the pin of the key the Ircd presented, and whether a certificate authority or a pin verified it (CONN-1).
    - Closing is recorded whenever the Daemon decides to end a Connection, with its reason and whether it chose to leave (LIVE-9). Only a chosen leave is not a failure.
    - A close says whether it was a refusal (LIVE-5). A refusal seen while a close is under way outranks the reason that started it, because a Network that bans us at accept closes the socket before we can read why.
    - A Connection the Log could not close, because appends were failing (LOG-9), gets its close once appends succeed, with that reason, so that it is never mistaken for a killed process.
  - **Change:** something the Owner altered, such as Configuration, a Read Marker, an ignore, or an API key, with the name of the key that altered it, `local` for `iirc key create` (AUTH-4), or `mode` for a Channel key a Network set (CRED-4), and the Network it concerns, if any.
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
  - A Frontend's request is recorded as `key:` and its key name, such as `key:phone`. The request ID joins it with SEND-10.
  - A remembered Join is a Change, and the reconciler sends its `JOIN` as `rejoin`, so the Change before it, which names the key, is the answer. Nothing else can send a duplicate `JOIN`.
  - Automatic behaviour is recorded by name, such as `ping-reply`, `lag-check`, `rejoin`, `away-restore`, `ctcp-reply`, or `nick-regain`.
- **LOG-6.** Credentials the Daemon holds stay out of the Log. Both layers run before an append, in both directions:
  - **Typed operations:** a Line built from a Credential is marked sensitive where it is constructed.
  - **Value scrubbing:** any stored Credential value found in any Line is replaced, whatever the command. This catches an echo, or the Owner pasting a password.
  - A redacted Entry keeps the rest of its Line and is marked redacted, with the names of the Credentials removed. Each removed value becomes `<redacted>`, and the names go in the order those stand in the Line, one for each and a Credential removed twice named twice, so that the nth `<redacted>` is the nth name.
  - Scrubbing matches a value only as a whole word, bounded by the Line's start or end, a space, `:`, or `,`. A Channel key such as `pizza` would otherwise redact the word in every Message.
  - The host acts on the Entry as recorded, never on the bytes before scrubbing, so replay agrees with what happened.
  - A secret the Daemon never held, such as a password typed to a service, is recorded like any other Line, and LOG-7 can remove it.
- **LOG-7.** Entries are never edited or deleted by normal operation.
  - An `admin` key can redact an Entry's bytes, for the day a secret gets through. The Entry and its sequence remain, and a Change records who redacted it.
  - Redaction empties the bytes and marks the Entry redacted. Derived rows from it are derived again, so a Message it carried disappears.
  - Only a Line or a Dropped Entry has bytes to redact. The edit and its Change are one transaction, and the Entry names that Change.
  - Every derived table is derived again in that transaction, as a start would, so a restart reads what it leaves (LOG-10). It holds the writer as long as a start's rebuild takes, which suits something done on a rare day.
  - `Standing` keeps what the host knew until the next start, because a Connection under way acted on the Line as it was. A start replays a redacted Line as one with no bytes, which says nothing, so what only it told `Standing` is forgotten, such as a kick, `NICKLEN`, a `JOIN` failure, or a sign of login. What was recorded because of it still stands, such as a `closed` that was a refusal. Rows derived from later Entries follow the replay and not `Standing`, so that they are the rows a rebuild writes.
  - Deferred: pruning and retention. Nothing is pruned until we know what a year of Log costs, including large `LIST` replies.
- **LOG-8.** Times are when the Daemon recorded the Entry. Order comes from sequence numbers, never from clocks, because clocks can jump.
  - No wait for a reconnect is ever longer than its own delay from now, so a clock set back cannot keep a Network offline.
  - Deferred: deadlines within a Session still use wall-clock times, so a clock set back by some amount delays noticing a dead Connection by as much.
- **LOG-9.** If the Log cannot be appended to, the Daemon closes its Connections and reports the fault. It never carries on unrecorded, and it resumes on its own once appends succeed.
- **LOG-10.** Projections are disposable. Deleting every derived table and restarting gives identical API results.
  - A fold depends only on Entries and the code. Time-sensitive rules, such as casefolding and Highlights, use what was in force at that Entry.
- **LOG-11.** No read can delay an append. `bun:sqlite` is synchronous, so `/search`, `/state`, and Timeline replay run in a Worker on their own read connection.
  - Reads are paged and check a deadline between pages, because a running `bun:sqlite` query cannot be interrupted, even by terminating its Worker.
  - Search orders by recency by default. Deferred: ranked search, which needs a subprocess if it is to have a hard limit.
  - The writer stays on the main thread, because commits measured 1 ms at p50 and 26 ms at p99.9. Deferred: measuring this again under real traffic.

The Log lives in SQLite through `bun:sqlite` in WAL mode, with derived tables updated in the same transaction as the Entry and FTS5 for search.

## Configuration

Configuration is what the Owner wants, and the Log's Change Entries record it. Derived state is what is true right now. They stay separate: "autojoin `#foo`" is Configuration, and "we are in `#foo`" is derived.

- **CONF-1.** Configuration is a projection of Change Entries. There is no second source of truth, and its full history is inspectable.
  - Accepting a change and reading a recorded one are separate questions. The Schemas in `@iirc/api` hold every rule a request must meet, so a Frontend can check one before sending it, and a request they pass needs no other check by the Daemon. A bad request is refused with the path of each thing wrong (API-3).
  - A recorded Change is read for what it meant when it was recorded, never against today's rules. A field added since then takes the value that its absence meant, a Tuning number that no longer exists is dropped, and anything else that a rule made since would refuse is folded as it was. So tightening a rule cannot keep the Daemon from starting on a Log it once accepted. Deferred: a version per Change, until a change of meaning needs more than a default.
  - The Daemon will not start on a Change it cannot read at all: one of no kind it knows, such as a newer iirc wrote, or one without the shape its kind always had. It says the Change's sequence and why, because Configuration without that Change would not be what the Owner asked for.
- **CONF-2.** All Configuration can be read and changed through the API while the Daemon runs. A running Session applies a change without a restart where IRC allows it, and otherwise at the next Connection.
  - Applied at once: enabled, Channels, and the `QUIT` reason. A Channel taken off the list is parted if Self is in it, and a newly wanted one is joined. Turning autojoin off parts nothing, because it only stops the Daemon joining.
  - Applied at the next Connection: Ircds, Identity, Credentials, services, connect commands, and Tuning. A change to any of them retries straight away (LIVE-4), so a Network waiting out a backoff or a refusal picks it up at once.
- **CONF-3.** A Network has a stable ID and a display name, plus an enabled flag and these settings. The ID is up to 32 lowercase letters, digits, and `-`, starting with a letter or digit, and the Owner chooses it. Connect and disconnect set the enabled flag.
  - **Ircds:** an ordered list of host, port, TLS on or off, and an optional pinned key.
  - **Identity:** nick, alternate nicks, username, and realname.
  - **Credentials:** `PASS`, a service password, a TLS client certificate, and SASL details, each by name.
  - **Services:** which nicks are services. Defaults to `NickServ`, `ChanServ`, and the usual `*Serv` names.
  - **Connect commands:** Lines to send after registration and before joining, which refer to Credentials by name.
  - **Channels:** name, autojoin, rejoin-on-kick, key by Credential name, and notification level.
  - **Tuning:** encoding, flood control, liveness, and CTCP replies. Only values the Owner changed are stored, so a new default reaches every Network that never changed it. Each number has bounds and a default, which the API's Schema publishes, and a number left out is checked against the others at its default.
- **CONF-4.** The process itself needs only a data directory and a listen address, both given as flags or environment variables. Networks are added through the API, so a fresh Daemon needs no config file.
- **CONF-5.** What the Owner does through the API is intent, and it survives a reconnect.
  - Join adds the Channel to Configuration with autojoin on, unless asked not to. Part removes it.
  - Join and Part with no Session still record their Change, and the Channel is joined once the next Session's burst completes. A Join that is not to be remembered needs a Session (API-10).
  - Join clears a kick (LIVE-8), even with no Session.
  - Changing nick updates the configured nick, unless marked temporary. Otherwise nick regain would undo it.
  - Setting away stores the reason, and it is reapplied after `001`.
  - A Channel entered any other way, such as through Raw or an Ircd forcing it, is not remembered.
- **CONF-6.** TOML is a view of Configuration, never its truth ([ADR 0004](../adr/0004-configuration-lives-in-the-log.md)).
  - `iirc config export` writes Configuration as TOML, with Credentials as names only.
  - `iirc config import` applies a file as one Change. A file is only ever an input, and the Daemon never watches or rewrites one.
  - A file is the whole Configuration, so importing it removes any Network it leaves out.
  - API keys are not Configuration, and never appear in a file.
  - Both are Frontends of API operations (API-1).

### Credentials

- **CRED-1.** Credentials live outside the Log, behind one `Credentials` service, and Configuration refers to them by name. The service uses `Bun.secrets` where a keyring is available, and otherwise a file with mode `0600` in the data directory. Status shows which.
  - Once the keyring holds them, a marker file in the data directory says so. A start that finds the marker and no keyring refuses, rather than begin again with none.
  - A start refuses a `credentials.json` looser than `0600`, because other users may already have read it, and says to rotate what it holds. It never loosens or tightens the mode itself.
  - A name is up to 64 lowercase letters, digits, `.`, `_`, and `-`, starting with a letter or digit.
  - Setting or deleting a Credential is a Change that records its name, never its value. It counts as a relevant Change (CONF-2) for every Network whose Connections use it.
  - A Channel key only has the host build its next `JOIN` with the key as it is now. A Network sets keys itself, and would otherwise skip its own backoff by setting one each time it closed a Connection.
  - The file is replaced atomically, so a crash leaves the old value or the new one.
  - A write is waited for at most 10 seconds, because a keyring that answered the start can stop answering later, as a locked one does. The caller is then told `CredentialsUnavailable`, and from then on that write has failed, whatever the keyring does. No Change is recorded for it, and a Channel key that was being kept is neither stored nor named, so a later `MODE +k` tries again. The write itself is not cancelled, and nothing else is written until it and its undoing end, since a late write of the whole document would replace what a later one kept. Until then, every other Credential write fails at once with `CredentialsUnavailable`, and every other kind of Change goes on.
  - If a write that failed this way lands late, the service writes back the document it holds, which is what it held before that write, before it lets another begin. So the keyring, the live Credentials, and the Log agree, and so does a restart. If the write itself fails, there is nothing to undo. If the undoing fails, Credentials cannot be written until the Daemon restarts, and every write gives `CredentialsUnavailable`, while reads still serve what is held.
  - Configuration may refer to a name that is not set yet, so that a file can be imported first. Such a Network makes no `attempt`, and status lists the missing names.
- **CRED-2.** They are write-only through the API. A Frontend can set, replace, or delete a Credential and can see that it exists, but can never read it.
- **CRED-3.** In memory they stay in `Redacted` values, so they cannot reach logs, traces, errors, or API responses.
- **CRED-4.** Channel keys are Credentials.
  - A key given to Join is stored. It is updated on an observed `MODE +k`, deleted on `-k`, and a key shown as `*` is ignored.
  - A key is stored under the name the Channel gives it. For a Channel that gives none, the name is `key.` and the first 16 hex digits of the SHA-256 of the Network's ID, a NUL, and the Channel as it is compared, so it is the same however the Owner spells the Channel. The Channel then names it.
  - The Credential is stored, then its Change is recorded, with `by` set to `mode` or the Join's key name, and only then does the Channel name it.
  - A Join that is not to be remembered stores nothing, and its `JOIN` is sensitive like any other, so the Log has `<redacted>` in place of the key.
  - Once stored, a key is scrubbed like any other Credential (LOG-6). A `+k` seen for the first time is recorded as it arrived.

## Connections and Sessions

### Connecting

- **CONN-1.** TLS is the default and verifies the certificate and hostname, sending SNI.
  - Plaintext requires an explicit `tls: false` on that Ircd.
  - Skipping verification requires a pinned key, because a bare "accept anything" option does not exist.
  - A pin is `sha256/` and the base64 SHA-256 of the key's SubjectPublicKeyInfo, as `curl --pinnedpubkey` reads it. A pinned Ircd is verified by its pin alone, so a self-signed certificate works, and the hostname is not checked.
  - A pin that does not match closes the Connection before anything is sent, and the reason gives the pin the Ircd presented, so that the Owner can pin it after checking. A mismatch backs off like any failure and is not a refusal.
  - Connecting times out after 15 seconds, and any single write after 10.
- **CONN-2.** Registration sends `PASS` if configured, then `NICK` and `USER`, and finishes on `001`. It times out after 60 seconds, because slow ident and DNS on old Ircds are normal.
- **CONN-3.** The nick in `001` is the truth, and a later `NICK` from the Ircd is too. An Ircd can rename us, for example when services enforce a reserved nick.
- **CONN-4.** A taken or refused nick during registration works through a fixed, finite list.
  - The list is the configured nick, the alternates, the nick padded with `_` up to the limit, then the tail overwritten with numbers from 1 to 99.
  - The limit is `NICKLEN` from the Network's last Session, read from the Log. On first contact it is 9, because `NICKLEN` arrives only after `001`, and ngircd refuses an over-long nick with `432`.
  - `432`, `433`, `436`, and `437` each move to the next candidate. `437` counts only when its parameter is our nick, because it also applies to Channels.
  - When the list runs out, the attempt closes and backs off like any failed Connection, and status says why.
- **CONN-5.** Once the burst is complete (CONN-7), the Daemon tries to regain its configured nick.
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

### Staying connected

- **LIVE-1.** `PING` always gets a `PONG`, in every phase until the Connection starts to close, through the control lane (SEND-1). The `PONG` echoes the token's bytes exactly, whatever their encoding. A closing Connection answers nothing, because a `PONG` could only follow the `QUIT`.
- **LIVE-2.** Silence decides whether a Connection is dead. Any inbound Line proves it is alive. With no inbound Line for 90 seconds, the Daemon declares it dead, so a silently dropped TCP connection is noticed within that time.
- **LIVE-3.** The Daemon sends its own `PING` with a unique token every 60 seconds, busy or not, through the control lane. The round trip is the Network's lag, derived from the Log.
- **LIVE-4.** An unexpected close starts a reconnect.
  - Delays grow from 5 seconds to 5 minutes, with jitter over the upper half of each delay, and reset after a Session has stayed up for 5 minutes.
  - Attempts rotate through the Ircds.
  - Backoff state is derived from Connection Entries, so a crash loop under a service manager cannot hammer a Network.
  - A relevant Change (CONF-2), or an explicit connect, retries straight away, even during a refusal's wait. The fold knows this from the Change's sequence, so a restart agrees.
- **LIVE-5.** A refusal backs off for at least 30 minutes, and status shows the Network's own text verbatim.
  - A refusal is `463`, `464`, `465`, or any `ERROR` or `FAIL` before `001`, unless it is known to be transient, such as a ping or registration timeout.
  - `FAIL NICK` is not a refusal, because Ergo sends it after `433` for a reserved nick, and that is CONN-4's fallback.
  - Wording is at most a hint, never the rule. Ergo never sends `465`, and bans with a bare `ERROR`.
  - Known transient wordings are limits and restarts, such as ngircd's `Server going down`, `Connection limit reached`, and `too many connections from your IP address`, and Ergo's connection throttle, `Too many clients from your network`, and temporary restrictions. They back off like any failure, which already reaches 5 minutes. Bans and `Access denied` are refusals.
- **LIVE-6.** A reconnect is a new Session. Derived Channel state, lag, and every `RPL_ISUPPORT` token are cleared on close, then rebuilt from what the Ircd says, never carried over.
- **LIVE-7.** After the burst, the Daemon rejoins Channels with autojoin on.
  - It batches `JOIN`s by line length, with keyed Channels first (SEND-11).
  - An unsolicited `JOIN` from the Ircd is the truth, so a Network that kept us attached is not rejoined. Ergo's always-on mode does this, and replays those `JOIN`s just after `376`, so rejoining waits 1 second after the burst for them.
  - Each Channel's failure appears in status. `471`, `473`, `474`, `477`, and `437` retry with backoff, and `475` does not.
- **LIVE-8.** A kick wins over autojoin. The Channel is not rejoined, in this Session or the next, until the Owner joins again or the Channel has rejoin-on-kick, which waits 10 seconds. An `INVITE` is recorded and never followed automatically.
- **LIVE-9.** Disconnecting through the API or stopping the Daemon sends `QUIT` with a configured reason through the control lane, waits up to 2 seconds for the queue, and does not reconnect until connected again. Removing a Network does the same.
- **LIVE-10.** Time the Daemon was away from a Network is a Gap. Gaps are visible, derived from Connection and Daemon Entries, and shown in the affected Timelines. The Daemon never implies that nothing happened.
  - On a Network that keeps us attached, a Gap means only that we were not listening. Other Users may not have seen us leave.
- **LIVE-11.** A local close stops acting at once, and keeps recording what the Ircd already sent until it hangs up or 5 seconds pass, so that `ERROR` and whatever follows it are not lost. Sends are refused during this time, and status shows the phase once the close is recorded.
  - A stop keeps recording for at most the `QUIT` wait (LIVE-9). A silent Connection and a Log that cannot append do not wait, because there is nothing to read or nowhere to record it.

### Sending

- **SEND-1.** Outbound Lines leave through three lanes in strict priority, and in order within a lane.
  - **Control:** `PONG`, lag `PING`, registration, and `QUIT`. These skip flood control.
  - **Interactive:** anything a Frontend asked for.
  - **Background:** join-time reads, CTCP replies, `ISON`, and rejoining.
- **SEND-2.** Flood control over the interactive and background lanes is a token bucket with a burst of 5 and one Line every 2 seconds. An Owner can tune it per Network.
  - `PENALTY` and similar `RPL_ISUPPORT` hints may tune this later, but nothing depends on them.
- **SEND-3.** The interactive and background lanes each hold at most 1000 Lines. A send beyond that is refused, rather than dropped later.
- **SEND-4.** Nothing outlives its Connection. When a Connection ends, queued Lines become Dropped Entries, and a Message is not sent hours later into a conversation that has moved on. If a Frontend wants to retry, it decides that with full knowledge.
- **SEND-5.** A Message that does not fit is split into several Lines, measured in bytes after encoding.
  - The limit is `LINELEN` if advertised and otherwise 512, less the line ending, the command and Target, and the prefix the Ircd will add.
  - That prefix is reckoned from Self's nick plus the worst case for `USERLEN` and `HOSTLEN`, defaulting to 20 and 64. A hidden host can change without notice, and a few spare bytes cost less than silently cut text. Ergo refuses an over-long Message whole by default.
  - If no usable payload remains, the send is refused.
- **SEND-6.** Splits prefer word boundaries and always fall on grapheme boundaries.
  - A newline in the text starts a new Line, and empty lines are dropped, because a blank Line is an error on an Ircd.
  - An `action` keeps its CTCP wrapper on every Line.
  - All Lines from one send share a group ID.
- **SEND-7.** One send may produce at most 20 Lines, and more than that is refused. The Frontend decides what to do with a large paste.
- **SEND-8.** Text is sent as UTF-8 unless the Network sets another encoding. `UTF8ONLY` overrides that setting. Text containing NUL or a bare CR is refused, because an Ircd may disconnect us for it.
- **SEND-9.** An error that follows a send is linked to it and shown on it.
  - `401`, `403`, and `404` link by Target. `417` has no Target, so it links to the newest send.
  - On a bare Network this link is a best effort, and the API says so.
  - It can report a refusal but never prove delivery, and a `NOTICE` may be refused silently.
- **SEND-10.** A send may carry a request ID. It is stored in the cause and echoed on results, and a repeat with the same ID returns the original result, so a Frontend can retry safely.
- **SEND-11.** Commands that take lists are split like text. `JOIN` splits on commas with keyed Channels first and keys aligned to them, and `ISON` splits on spaces.

## What the Daemon knows

Each item here is derived from the Log.

### Network state

- **KNOW-1.** The Network's phase, burst state, the Ircd and TLS details, lag, Self's nick, `user@host`, and modes, and away state.
  - Self's mask follows `396`, `900`, `901`, and Self's own `JOIN`.
- **KNOW-2.** Every `RPL_ISUPPORT` token for the current Session, including removals (`-TOKEN`).
  - Where a token was never sent, these defaults apply: `CASEMAPPING=rfc1459`, `CHANTYPES=#&`, `PREFIX=(ov)@+`, `CHANMODES=beI,k,l`, and `MODES=3`.
  - An empty value differs from an absent token. `PREFIX=` means no prefixes, and `MODES` with no value means no limit.
  - Value escapes such as `\x20` are decoded.
- **KNOW-3.** Nicks and Channel names are compared after casefolding under the mapping in force at that Entry.
  - The fold comes from `CASEMAPPING` and `UTF8MAPPING` together, covering `ascii`, `rfc1459`, `rfc1459-strict`, the variant spelling `strict-rfc1459`, and `rfc8265`. Ergo's `precis` mode advertises `CASEMAPPING=ascii` with `UTF8MAPPING=rfc8265`.
  - Anything unrecognised falls back to `ascii`, which splits names rather than merging them, and is reported in status.
  - An Owner can override the mapping, because Ergo's `permissive` mode looks the same as `ascii` on the wire.
  - Display keeps the most recently seen spelling.
  - Deferred: what happens to existing Targets when a Network's mapping changes. Until then, a Target keeps the identity it was given.

### Channels and Users

- **KNOW-4.** For each Channel: topic, who set it and when, modes, creation time, and members with their prefixes, ranked by `PREFIX`.
- **KNOW-5.** Membership and topic come from what `JOIN` already returns.
  - The Daemon sends only `MODE`, and `WHO` for `user@host`, through the background lane. A large Channel can delay these, and they never delay a Message.
  - `353` up to `366` is an atomic replacement of the member list.
  - `332`, `324`, and `353` never change state for a Channel Self is not in.
  - Without `multi-prefix`, a member with `@+` shows only `@`, so removing a prefix mode schedules a debounced `NAMES`.
- **KNOW-6.** `MODE` Lines are parsed using `PREFIX` first and then `CHANMODES`, so that list, parameterised, and flag modes are told apart.
  - A letter the Network never advertised takes no argument. If the arguments then fail to add up, the `MODE` is kept raw, the Channel is marked uncertain, and its modes and members are read again.
  - A key shown as `*` is hidden and is not stored.
- **KNOW-7.** A User's nick, `user@host`, and realname are remembered as seen, and away state where known.
- **KNOW-8.** `QUIT` and `NICK` Lines name no Channel. They are attributed to every Channel the User shared with Self at that moment, which only a fold over the Log can determine. A `NICK` or `QUIT` from a Direct Message partner also appears in that Timeline.
- **KNOW-9.** A `470` forward puts us in a different Channel from the one requested. It is reported against the configured name, so autojoin does not look like it failed.

### Messages and Activity

- **MSG-1.** `PRIVMSG` and `NOTICE` become Messages of kind `privmsg`, `notice`, or `action`. Self's Messages come from outbound Lines, because the floor has no `echo-message`.
- **MSG-2.** Each inbound Line belongs to one place, decided in this order:
  - Anything before `001`, with Target `*` or `AUTH`, or with no source or a source that is not `nick!user@host`, goes to the Network's Timeline. This keeps Ircd notices from becoming Direct Messages and Highlights.
  - A Channel Target goes to that Channel. A `STATUSMSG` prefix such as `@#chan` belongs to `#chan`, and stays as an attribute.
  - A `$` mask goes to the Network's Timeline.
  - An inbound Line sourced from Self is a Self Message.
  - Any other Target is a Direct Message from its sender, even if the Target does not match Self.
- **MSG-3.** Text keeps its IRC formatting codes.
  - The API offers both the raw text and a parsed form with those codes as spans, so that a Frontend never has to interpret them. Both are data and never markup.
  - Highlights and search run on text with the codes stripped.
- **MSG-4.** Inbound bytes decode as UTF-8, then through the Network's configured fallback encoding, then Latin-1. Decoding never fails.
  - Deferred: which encodings beyond Latin-1. We add whichever the first real Network needs.
- **MSG-5.** Activity covers joins, parts, quits, kicks, nick changes, topic changes, mode changes, invites, and CTCP requests.
- **MSG-6.** Lines with no Channel or User to belong to, such as the MOTD, `WALLOPS`, and most numerics, go to the Network's Timeline.

### Timelines and attention

- **VIEW-1.** A Timeline is the ordered Messages and Activity of one Channel, one Direct Message partner, or one Network, paged in either direction. Its order is a derived position, and it matches sequence order until history is filled in (see [`chathistory`](#filling-gaps)).
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

### Frontend storage

Frontends can keep small values in the Daemon, so that a theme or layout follows the Owner across devices.

- **STORE-1.** Storage is key-value, grouped by a namespace each Frontend chooses, such as `web`. Values are opaque JSON that the Daemon never interprets.
- **STORE-2.** A write is a Change Entry, so storage is a projection like everything else, and it rebuilds and has history.
  - A value is at most 64 KB.
  - Because writes stay in the Log, this is for settings, not for something that changes on every keystroke.
- **STORE-3.** Writes reach other Frontends through `/stream`. The last write wins, unless a write carries the `at` it read, in which case it is refused if the value has since changed.
- **STORE-4.** Anything the Daemon acts on stays in Configuration, such as notification levels, ignores, and pinned Targets. Storage is only for what Frontends alone read.
- **STORE-5.** Storage is not for secrets. Any `read` key can see it.

## Lookups

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

- **PROT-1.** The Daemon handles `PRIVMSG`, `NOTICE`, `JOIN`, `PART`, `KICK`, `QUIT`, `NICK`, `TOPIC`, `MODE`, `INVITE`, `AWAY`, `ERROR`, `PING`, `PONG`, and all numerics in the Modern client protocol. Any other command is still recorded, and appears in the Network's Timeline as an unknown Line.
- **PROT-2.** CTCP `ACTION` is a Message. Other CTCP requests are Activity.
- **PROT-3.** The Daemon answers CTCP `VERSION` with `iirc` and echoes the sender's argument to CTCP `PING`, and answers nothing else by default. `TIME` reveals a timezone, so it is opt-in.
- **PROT-4.** CTCP replies go out as `NOTICE`, at most one per User per 10 seconds and 5 per minute per Network. No automatic reply is ever sent in response to a `NOTICE`.
- **PROT-5.** DCC requests are recorded and never acted on.
- **PROT-6.** `FAIL`, `WARN`, and `NOTE` are parsed on every Network, whatever was negotiated. Ergo sends them unconditionally.

### Hostile input

- **HOST-1.** No sequence of bytes from an Ircd can close a Session, stop the Daemon, or lose a Line. Unparseable input is recorded with its reason.
- **HOST-2.** Frames longer than 8704 bytes are cut and marked, not buffered without limit.
- **HOST-3.** Nothing a participant sends can make the Daemon do something beyond what this spec names. A CTCP flood is rate limited, and a Message is never interpreted as an instruction.
- **HOST-4.** The API marks all participant-supplied text as untrusted. Agents must treat it as data, because anyone on a Network can write text that an agent will read.
- **HOST-5.** One Network cannot starve another, and no Frontend can stall a Session (LOG-11). A slow reader is disconnected, and resumes from its cursor or gets `resync` (API-6).
  - The same holds in the process. Anything that watches Entries as they commit cannot hold up a commit. A watcher that falls behind is told which run of sequences it missed, and is never left to miss them silently.

## API

`HttpApi` in `@iirc/api` defines the contract, and implementations follow it. SSE and WebSocket are adapters over that contract, and SSE comes first. All of it is in the published OpenAPI document, except the WebSocket route, which shares `/stream`'s event Schema. All paths below sit under `/api`.

- **API-1.** Anything the Daemon can do is an API operation. No ability exists only as a flag, a file, or a console command. The first key is the one exception (AUTH-4).
- **API-2.** A Frontend never has to parse IRC. Every derived item carries the sequence of the Entry behind it, so that it can always be traced to bytes.
- **API-3.** Errors are typed and tagged. Operations distinguish a bad request, no Session, a full queue, a Line lost to its Connection, a failed write, a Log that is down, and a Network refusal.
- **API-4.** Line bytes, in a Line or a Dropped Entry, are returned as base64 beside the decoded text, because hostile bytes must survive JSON.
- **API-5.** `/status` reports the API version, and responses are compressed when asked.

### Reading

| Surface | Purpose |
| --- | --- |
| `GET /bootstrap` | Every Target, the latest items, and members, with one `at` |
| `GET /entries` | The Log, by cursor, with filters by Network and kind |
| `GET /messages` | Messages, by cursor, each with the sequence of its Line |
| `GET /gaps` | Gaps, by cursor, optionally for one Network |
| `GET /stream` | Replay from a cursor, then live, with no gap or duplicate at the join |
| `GET /status` | The Daemon and all Networks at a glance |
| `GET /networks`, `GET /networks/{id}` | Configuration, with Credentials as names only, and derived state |
| `GET /configuration` | All Configuration at once, as `iirc config export` reads it |
| `GET /networks/{id}/targets` | Targets, with unread counts by class |
| `GET /networks/{id}/targets/{target}` | Topic, modes, and members of a Channel, or a partner's details |
| `GET /networks/{id}/targets/{target}/timeline` | A Timeline, paged in either direction |
| `GET /search` | Full-text search |
| `GET /storage/{namespace}` | A Frontend's stored values |
| `GET /state?at={sequence}` | Derived state as it was at that Entry |
| `GET /health` | Unauthenticated liveness for service managers |
| `GET /metrics` | Metrics for scraping |

- **API-6.** `/stream` is the only thing a Frontend needs to stay current.
  - It carries Entries, the Messages and Activity derived from them, and typed changes to derived state, such as members, topic, modes, counts, Read Markers, phase, lag, Configuration, and stored values, all under the Entry's sequence as the Server-Sent Event ID.
  - Reconnecting with `Last-Event-ID` resumes exactly.
  - Every derived read returns `at`, the sequence it reflects. Starting `/stream` from that value leaves no gap.
  - It filters by Network and kind, and offers a notifications-only mode.
  - A cursor too far behind receives `resync`, and the Frontend calls `/bootstrap`. A phone back after a month must not replay the Log.
  - A quiet stream sends typed heartbeats, so a dead reader is noticed.

### Acting

| Operation     | Effect                                                                |
| ------------- | --------------------------------------------------------------------- |
| Send          | A Message of kind `privmsg`, `notice`, or `action`, or a CTCP request |
| Thin Send     | `POST /messages`: one `PRIVMSG` to one Target, until Send replaces it |
| Membership    | Join with an optional key, part, invite, kick                         |
| Channel       | Set a topic, change modes in `MODES`-sized batches                    |
| Self          | Change nick, set or clear away, set user modes, `OPER`                |
| Lookups       | As in [Lookups](#lookups)                                             |
| Network       | Add, change, remove, connect, disconnect                              |
| Configuration | Replace all of it as one Change (CONF-6)                              |
| Raw           | Send any Line the library can construct safely                        |
| Marking       | Move a Read Marker, set ignores, Highlight keywords, and levels       |
| Storage       | Set and delete a Frontend's stored values                             |
| Credentials   | Set, replace, and delete                                              |
| Redaction     | Remove an Entry's bytes (LOG-7)                                       |
| Backup        | Write a copy of the Log to `backups/` (RUN-2)                         |
| Keys          | Create, list, and revoke API keys                                     |

- **API-7.** Convenience such as `/op` or `/ban` is a Frontend's job, built on the modes operation. The API stays small.
- **API-8.** A raw Line changes nothing directly, and derived state still follows what the Ircd says.
- **API-9.** An operation returns once its Lines are written or refused, and gives the sequences it produced. Send times out with the Lines' status if the queue is slow.
  - An operation that recorded a Change always succeeds with that Change's sequence, and a Line it then could not send is reported beside it as `failed`, with its typed error. A Line that would change nothing, such as `JOIN` for a Channel Self is in, is `skipped` with its reason.
- **API-10.** Acting on a Network with no Session returns a typed error at once. Nothing is held for later (SEND-4).

### Access

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
  - The web frontend is always served from the same origin as the API, in every [deployment shape](architecture.md#deployment-shapes).
  - A key is exchanged once for an `HttpOnly`, `SameSite=Strict` cookie, and state-changing requests also check `Origin`.

## Observability

- **OBS-1.** Everything in this spec that the Daemon decides is explainable from the API: why it reconnected, why it picked that nick, why a Line was dropped. No knowledge exists only in a process log.
- **OBS-2.** Spans, logs, and metrics are emitted through Effect and can be exported over OpenTelemetry. No Credential or Message text appears in them.
- **OBS-3.** Metrics include Lines in and out, depth of each lane, Dropped Lines, lag, reconnects, Log append latency, and Log size.
- **OBS-4.** The lifecycle machine's state for each Network is part of status.

## Running it

- **RUN-1.** `bun build --compile` produces one executable, `iirc`, with a systemd user service that restarts it on failure. Arguments choose the [deployment shape](architecture.md#deployment-shapes).
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

- **PROOF-1.** Every requirement has a test that cites its ID where a test is possible. Scripted Ircds cover failure modes that a real Ircd will not produce on demand, and clocks are injected so timer behaviour is tested exactly.
- **PROOF-2.** `testdata` conformance vectors cover the library. Protocol parsing is fuzzed with random bytes.
- **PROOF-3.** Before a release, the Daemon passes against each real Ircd in the matrix: ngircd as the floor, and Ergo under `default.yaml`, `traditional.yaml`, and `precis` casemapping.
  - `bun run proof:floor` covers ngircd. It starts private ones on free loopback ports, makes the first key with `iirc key create`, and drives the built binary only through its API, signals, `iirc config`, and raw IRC clients.
  - It checks LIVE-2 to LIVE-10, CONN-3, CONN-4, and SEND-2.
  - It checks two Networks on two Ircds, where one going down leaves the other's Sends flowing (HOST-5, CONF-3), and Join and Part, seen live and kept across a restart (CONF-2, CONF-5).
  - It checks export and import of Configuration, including a refused file (CONF-6), and keys by scope and after revoking (AUTH-1 to AUTH-3).
  - It checks TLS pinning against a self-signed certificate (CONN-1). Against an ngircd built without TLS it skips that check and says so.
  - It checks `PASS` (CONN-2), a service login that waits out the login wait and a connect command (CONN-6), and a Channel key from a Join, kept across a restart and replaced by a `MODE +k` (CRED-4). It checks that a missing Credential holds every `attempt` back until it is set (CRED-1), and that a backup passes `quick_check` (RUN-2). No Credential's value is in the Log's files or the backup, but for the first `+k` (LOG-6).
  - It checks a TLS client certificate by the fingerprint ngircd says it saw. Against an ngircd without TLS, or one that never says, it skips that check and says so.
- **PROOF-4.** Kill tests send `SIGKILL` during traffic, then check that no recorded Line is missing or duplicated and that projections rebuild identically. This does not test power loss, which rests on `synchronous=FULL`.
- **PROOF-5.** Soak test: two Daemons share a Channel on the floor Ircd, one sends a counted Message each minute, and the other checks that none are missing. The first proof in the vision is 30 days of this passing on a real Network as well, with every Gap explained.

## IRCv3 enhancements

Each of these is detected, never assumed. A Network setting turns them all off, and the floor test matrix runs with it off.

### Negotiation

- **CAP-1.** `CAP LS 302` goes before `NICK` and `USER`. An Ircd without capabilities ignores it or rejects it harmlessly, and registration carries on.
- **CAP-2.** Registration holds until `CAP END`, so negotiation has its own short timer.
- **CAP-3.** Only an exact allowlist is requested. One unknown name refuses a whole `REQ`, and Ergo disconnects anyone who requests its trap capability, so "request everything" is not an option.
- **CAP-4.** Multi-line `LS` replies are collected, `NAK` retries each capability on its own, and `CAP NEW` and `CAP DEL` update live state.

### Capabilities

| Capability | Improves | Without it |
| --- | --- | --- |
| `sasl` | Authentication before joining | `PASS` and service `IDENTIFY` (CONN-6) |
| `server-time` | True Message times, kept beside `at` | Time of receipt |
| `echo-message` with `labeled-response` | Confirmed sends, enabled only as a pair | Own outbound Lines (MSG-1) |
| `labeled-response` | Exact Lookup and send correlation | The table (LOOK-3), best-effort errors (SEND-9) |
| `message-tags` | Carries `msgid` for deduplication | Each Line stands alone |
| `batch` | Grouped netsplits | Each Line stands alone |
| `draft/chathistory`, `draft/event-playback` | [Filling Gaps](#filling-gaps) | The Gap remains visible |
| `away-notify`, `account-notify`, `extended-join`, `chghost`, `setname`, `userhost-in-names`, `multi-prefix` | Fresher User state | `WHO` and `NAMES` when needed |
| `standard-replies`, `invite-notify` | Better-typed errors and Activity | Numerics |
| `draft/multiline` | One Message across Lines | Splitting (SEND-5) |
| `sts` | Persisted upgrade to TLS | Configured TLS (CONN-1) |
| `draft/read-marker` | Read Markers shared with other IRC clients | Shared among Frontends only |

### Other mechanisms

These are not capabilities, so they are detected differently:

| Mechanism | Detected by | Improves | Without it |
| --- | --- | --- | --- |
| `MONITOR` | `RPL_ISUPPORT` | Instant nick regain, presence | `ISON` (CONN-5) |
| `WHOX` | `RPL_ISUPPORT` | Richer User state | `WHO` |
| `BOT` | `RPL_ISUPPORT` | Agents can mark Self as a bot | No marking |
| `reply`, `react`, `typing` | Client tags over `message-tags` | Richer conversation | Not shown |

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

## Beyond the first proof

These are wanted but not needed for the first proof:

- Pushing notifications to a phone through Web Push or a webhook.
  - It must not key on "no Frontend connected", because an always-on agent would suppress it forever.
  - It waits a few seconds and skips anything already read, sends a dismissal when a Read Marker moves, prunes dead subscriptions, and blocks internal addresses.
- Automatic away when no Frontend is connected.
- Importing logs from WeeChat, ZNC, or The Lounge.
- An MCP adapter and an `iirc` command-line Frontend.
- Link previews fetched by the Daemon, so that a Frontend's address is not exposed.
- A watch list of Users, built on `MONITOR` and `ISON`.

## Milestones

Each milestone is a working Daemon. Order is by what makes the next one possible.

| # | Name | Delivers | Done when |
| --- | --- | --- | --- |
| 1 | Stays on | LOG, CONF, CRED, CONN except CONN-5, LIVE, SEND lanes and flood control, a thin Send, `/entries`, Channel membership, RUN, multiple Networks, AUTH | It survives kills, drops, and refusals on fserv and loses nothing |
| 2 | Knows the Network | KNOW, MSG, HOST, PROT, Activity | Derived state matches `NAMES` and `MODE` after a netsplit and a reconnect |
| 3 | Full control | CONN-5, the rest of SEND, Lookups, Acting | Everything a person does in irssi can be done through the API |
| 4 | Ready for Frontends | `/bootstrap`, `/stream`, VIEW, STORE, OBS | The web frontend can start without asking for a Daemon change |
| 5 | Better with IRCv3 | [Enhancements](#ircv3-enhancements) | Ergo gives more, ngircd still passes |

Milestone 1 is built in this order, each step a working Daemon:

1. One Network, the durable Log, the machine as a fold, and a kill test.
2. Reconnecting and refusals: LIVE, CONN-3, CONN-4, CONN-7, SEND-1 to SEND-4, and LOG-9.
3. Configuration, multiple Networks, API keys, Channel membership, LOG-11's reader, and TLS key pinning.
   - That is CONF-1, CONF-2, CONF-4, CONF-6, CONF-3 without Credentials, services, connect commands, or notification levels, and CONF-5's Join and Part, keyless until Credentials exist.
   - AUTH-1 to AUTH-5, and AUTH-6's rule that keys travel in headers. Its WebSocket and AUTH-7's cookie come with the web frontend in milestone 4.
   - Every Network flag leaves `iirc daemon`, which takes only a data directory and a listen address (CONF-4).
4. Credentials, CONN-2's `PASS`, CONN-6, and the service unit.
   - That is CRED-1 to CRED-4, LOG-6, LOG-7, CONF-3's Credentials, services, and connect commands, and Channel keys for Join (CONF-5).
   - Also RUN-2 and RUN-5, because the soak test freezes the Log format, and every change after it needs a migration and a backup.
   - SASL details wait for milestone 5. A TLS client certificate is a Credential holding the certificate and key in PEM.

The soak test (PROOF-5) starts after step 4 and runs in the background. Nothing waits for it, and the Daemon runs alongside whatever IRC client the Owner uses.

The Log format is free to change, with no migrations, until the soak test starts. A tagged build runs the soak test, so day-to-day work does not interrupt it.
