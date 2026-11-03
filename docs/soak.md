# Running the soak test

PROOF-5 in [`specs/daemon.md`](specs/daemon.md): two Daemons share a Channel, one sends a counted Message every minute, and the other's Log is checked for gaps in the count. It runs for 30 days on the floor Ircd and on a real TLS Network, and every Gap in that time must be explained.

The harness is a Frontend, `iirc-soak` in `apps/soak`. It reaches both Daemons only through their HTTP API, with keys. Two instances of [`iirc@.service`](running.md) do the work, `soak-a` as the sender and `soak-b` as the receiver, each configured with the same two Networks. Two timers run `iirc-soak`: `send` every minute, and `check` every hour. Every placeholder in `<angle brackets>` below is yours to fill in, and none of it is committed.

The Log format is frozen once the soak starts, so a build that changes it needs a migration (RUN-5), and that is a reason to start the soak again.

## Tag and build

The soak runs a tagged build, so that day-to-day work cannot disturb it. Build from a worktree of the tag, which leaves your working tree alone:

```sh
git tag -a soak-1 -m "Soak build 1"
git worktree add ~/code/iirc-soak soak-1
cd ~/code/iirc-soak
bun install --frozen-lockfile
bun run build
```

That makes `apps/iirc/dist/iirc` and `apps/soak/dist/iirc-soak`. Install them as pinned copies, which only the upgrade steps below replace, and the units that use them:

```sh
install -Dm755 apps/iirc/dist/iirc ~/.local/opt/iirc/soak/iirc
install -Dm755 apps/soak/dist/iirc-soak ~/.local/opt/iirc/soak/iirc-soak

units=~/.config/systemd/user
install -Dm644 packaging/systemd/iirc@.service $units/iirc@.service
for unit in iirc-soak-send.service iirc-soak-send.timer iirc-soak-check.service iirc-soak-check.timer; do
  install -Dm644 packaging/systemd/$unit $units/$unit
done
for instance in soak-a soak-b; do
  install -Dm644 packaging/systemd/iirc@$instance.service.d/pinned.conf $units/iirc@$instance.service.d/pinned.conf
done
systemctl --user daemon-reload
```

The drop-ins point the two soak instances at `~/.local/opt/iirc/soak/iirc` and leave every other instance, such as `main`, on `~/.local/bin/iirc`.

## Create the two Daemons

Each instance has its own environment file, data directory, and keys. Choose two ports that nothing uses. The data directories are made first, with the mode the unit gives them, so that the keys go into a Log only you can read:

```sh
mkdir -p ~/.config/iirc
echo IIRC_HTTP_PORT=7701 > ~/.config/iirc/soak-a.env
echo IIRC_HTTP_PORT=7702 > ~/.config/iirc/soak-b.env

soak=~/.local/opt/iirc/soak/iirc
for instance in soak-a soak-b; do
  install -d -m700 ~/.local/state/iirc/$instance
done

# `iirc key create` needs the instance stopped, and prints each key once. `owner` is for
# configuring the Networks, and `soak` is the key the harness uses: it sends as soak-a
# (`chat`), and only reads as soak-b (`read`).
export IIRC_DATA_DIR=~/.local/state/iirc/soak-a
OWNER_A=$($soak key create --name owner)
SOAK_A=$($soak key create --name soak --scope chat)
export IIRC_DATA_DIR=~/.local/state/iirc/soak-b
OWNER_B=$($soak key create --name owner)
SOAK_B=$($soak key create --name soak --scope read)
unset IIRC_DATA_DIR

systemctl --user enable --now iirc@soak-a iirc@soak-b
```

Configure the same two Networks on both, with a different nick on each. Write `soak-a.toml`, and `soak-b.toml` with its own nicks:

```toml
[networks.floor]
name = "Floor"

[networks.floor.identity]
nick = "soak-a"

[[networks.floor.ircds]]
host = "127.0.0.1"
port = 6667
tls = false

[[networks.floor.channels]]
name = "#soak"

[networks.real]
name = "<the real Network>"

[networks.real.identity]
nick = "<soak-a nick>"

[[networks.real.ircds]]
host = "<irc.network.example>"
port = 6697

[[networks.real.channels]]
name = "<#a channel both Daemons can join>"
```

The real Network may need more: a pin, a login, a Channel key, or an `ircds` entry for each host. [`running.md`](running.md) covers each. Then import them:

```sh
IIRC_KEY=$OWNER_A $soak config import soak-a.toml --api-url http://127.0.0.1:7701
IIRC_KEY=$OWNER_B $soak config import soak-b.toml --api-url http://127.0.0.1:7702
```

Wait until `curl -s -H "Authorization: Bearer $SOAK_B" http://127.0.0.1:7702/api/status` shows both Networks in `session` with the Channel in `joined`. The Target can also be a nick, so that the soak sends a Direct Message to the other Daemon's nick, and then the Channel need not exist.

## The harness's environment

`~/.config/iirc/soak.env` holds the keys, so it is readable by you alone. Both units read it. Each pair names the Network on the sender, and for `check` the Network on the receiver too. The sender's key is in the file twice, because `send` reads `IIRC_KEY` and `check` reads `IIRC_SENDER_KEY`:

```sh
install -m600 /dev/null ~/.config/iirc/soak.env
cat > ~/.config/iirc/soak.env <<ENV
IIRC_KEY=$SOAK_A
IIRC_SENDER_KEY=$SOAK_A
IIRC_RECEIVER_KEY=$SOAK_B
SOAK_SENDER_URL=http://127.0.0.1:7701
SOAK_RECEIVER_URL=http://127.0.0.1:7702
SOAK_SEND_PAIRS="--pair floor=#soak --pair real=<target>"
SOAK_CHECK_PAIRS="--pair floor:floor=#soak --pair real:real=<target>"
ENV
```

Try each command once by hand before the timers take over:

```sh
set -a; . ~/.config/iirc/soak.env; set +a
~/.local/opt/iirc/soak/iirc-soak send --daemon $SOAK_SENDER_URL $SOAK_SEND_PAIRS
~/.local/opt/iirc/soak/iirc-soak check --sender $SOAK_SENDER_URL --receiver $SOAK_RECEIVER_URL $SOAK_CHECK_PAIRS --settle 5
```

Then turn the timers on. The Daemons keep running while you are logged out only with lingering on (`loginctl enable-linger`, which this machine already has):

```sh
systemctl --user enable --now iirc-soak-send.timer iirc-soak-check.timer
```

## What is sent and what is checked

`send` sends exactly one Message, `soak <minute> <millis>`, to each pair's Target through `POST /api/messages`. `<millis>` is the epoch millisecond the run began in, and `<minute>` is `floor(millis / 60000)`, the same for every pair of a run. It reads no Log and keeps no counter, so there is nothing for a slow Log, a restore, or a second run to get wrong. The pair of numbers is the Message's identity: two runs in one minute, which a clock stepped back can make a timer do, send two different Messages, and the checker tells you when that happened without calling it a failure. A minute is skipped only if the sender did not run in it, and the checker reports that as a silence. `send` exits 0 only when every send succeeded, and otherwise says why on stderr.

`check` keeps no state either. Each run reads both Logs in full, a page at a time until the Log gives an empty one, and judges every pair. It passes each Entry through a fold as it arrives and keeps only the counted Messages, Self's nick, and what bounds each Gap, so a month of a busy Channel costs no more memory than its counted Messages. Names are compared as the Network compares them, by the `CASEMAPPING` its `RPL_ISUPPORT` announced (`rfc1459` when it announced none), through the same fold the Daemon uses, and a nick is read from a source of any of the forms `nick!user@host`, `nick@host` and `nick`. Each Daemon's Log is read from one moment: the newest sequence is read first, only Entries up to it are folded, and the Gaps are read after it. A Gap recorded after that sequence is left for the next run, and so is the end of one that ended after it, so a window whose closing evidence has not been seen stays open.

- **Sent** is each `soak <minute> <millis>` the sender's Log shows it sending, as an outbound Line or a Dropped Entry. A Dropped Entry holds the Line, so it names the Message it belongs to by the same identity. A Drop whose text is not a counted Message explains nothing.
- **Received** is each `soak <minute> <millis>` the receiver's Log shows arriving as a `PRIVMSG` to that Target from a nick the sender said its Messages under, which the sender's Log names, so a nick change hides nothing.
- **Missing** is a Message sent and not received, once it has had `--settle` seconds to arrive (default 120). Each missing Message is judged alone, by its own identity and send time, and is **explained** if
  - the sender's Log shows that Message Dropped, so that it never left or may not have, or
  - a Gap on the receiver's Network, or the sender's, covers the time it was sent. A Gap covers a window the Logs bound, with no padding. It begins at the last inbound Line the Daemon recorded before the Gap began, because it was demonstrably listening up to then, and a Connection that died unnoticed was dead only after that (the Daemon notices after 90 seconds of silence, LIVE-2). It ends when the Daemon was listening on the Target again: the echo of its own `JOIN` of the Channel in its Log, read from the Lines with the same state fold the Daemon uses, or the `001` that ended the Gap if the Target is a nick. A Gap that has not ended, or that has no `JOIN` recorded after it yet, has an open window.
  - Otherwise it is **unexplained**. So a loss while both Daemons were joined is unexplained though one of them disconnects a minute later, and so is one after the `JOIN` was recorded.
- A Message sent or received more than once is a **duplicate** and fails. A Message received whose identity the sender never sent fails. Several different Messages in one minute are only told, as `repeated minutes` in the summary and `repeated` in the report.
- The sender fails as **silent** if a stretch of minutes longer than `--silence` (default 10) has no sent Message, between two sent minutes or since the last one, or if it never sent. A Dropped send still counts as the sender running. This is history, derived from the minutes, so a stop of 40 minutes fails every later check too, however well the sender runs afterwards. The summary and the report name the minutes.

It prints one line for each pair, and exits 1 on anything unexplained, duplicated, received but never sent, or silent. It exits 3 if it could not read a Log at all, because a check that could not look has proven nothing.

## Reading it

The journal has a line for each pair, every hour:

```sh
journalctl --user -u iirc-soak-check.service -n 20
journalctl --user -u iirc-soak-send.service --since -1h
systemctl --user list-timers 'iirc-soak-*'
systemctl --user --failed
```

```text
soak floor:floor=#soak OK: sent 1440; delivered 1437; explained 3 (1021-1023) by receiver Gap at Entry 8123: the Daemon was killed; last sent 12 s ago
soak real:real=nick FAILED: UNEXPLAINED in minutes 3 (400,402-403); sent 700; delivered 697; last sent 12 s ago
```

The report adds one line of JSON for each run to `~/.local/state/iirc/soak/report.jsonl`, with the time, and for each pair its counts and the numbers that matter, and `silences`, the minutes with no send. Lists of numbers are ranges, such as `"1021-1023,1500"`, and `""` is none. Problem lists, their counts, and `pendingMinutes` are by minute, so two Messages of one minute count once there, while `sent` and `delivered` count Messages. Explained misses are grouped by their reason:

```sh
jq -c 'select(.ok | not)' ~/.local/state/iirc/soak/report.jsonl | tail
jq -r '.pairs[].explained[] | "\(.count) \(.numbers) \(.reason)"' ~/.local/state/iirc/soak/report.jsonl | sort | uniq -c
```

When a check fails:

- **`UNEXPLAINED`** is the finding the soak exists for. Find `soak <minute> <millis>` in the sender's Log (`GET /api/messages?network=<id>`) for when it was sent, then look at the receiver's `GET /api/gaps?network=<id>` and `GET /api/entries?network=<id>` around that time, and at `/api/status`. A Message that left and never arrived is the Network's loss. One that did not leave is a Daemon bug. The check keeps failing every hour after that, and the 30 days start again once it is understood.
- **`DUPLICATED`** means a number arrived more often than it was sent, which is a Daemon or Network bug.
- **`RECEIVED BUT NEVER SENT`** means the receiver heard a number the sender's Log does not have: a restored or replaced sender Log, or another User on the nick.
- **`SENDER SILENT`** means some stretch of minutes, named in the line, had no Message recorded, or none ever was. Look at the journal of `iirc-soak-send.service` for those minutes. Check `systemctl --user status iirc-soak-send.service` and the sender's `/api/status`. A check that runs before the first minute's send can fail this way.
- Exit 3 and `could not check` mean a Daemon did not answer, or refused the key. The report records the run with the error.

## Upgrading the soak build on purpose

Do this only when the soak is meant to change, and note the tag where you keep the soak's record. A Log migration takes a backup first (RUN-5), and the restart is a Gap that the report explains. Keep the stop short: a sender silent for more than 10 minutes fails the next check.

```sh
git tag -a soak-2 -m "Soak build 2"
git worktree add ~/code/iirc-soak-2 soak-2
cd ~/code/iirc-soak-2
bun install --frozen-lockfile
bun run build

systemctl --user stop iirc-soak-send.timer iirc-soak-check.timer
systemctl --user stop iirc@soak-a iirc@soak-b
install -Dm755 apps/iirc/dist/iirc ~/.local/opt/iirc/soak/iirc.new
install -Dm755 apps/soak/dist/iirc-soak ~/.local/opt/iirc/soak/iirc-soak.new
mv -f ~/.local/opt/iirc/soak/iirc.new ~/.local/opt/iirc/soak/iirc
mv -f ~/.local/opt/iirc/soak/iirc-soak.new ~/.local/opt/iirc/soak/iirc-soak
systemctl --user start iirc@soak-a iirc@soak-b
```

Wait until both Networks are in `session` again, then start the timers:

```sh
systemctl --user start iirc-soak-send.timer iirc-soak-check.timer
```

## Ending it

```sh
systemctl --user disable --now iirc-soak-send.timer iirc-soak-check.timer
systemctl --user disable --now iirc@soak-a iirc@soak-b
```

The Logs stay in `~/.local/state/iirc/soak-a` and `soak-b`, and the report in `~/.local/state/iirc/soak`. Keep them as the record of the run.
