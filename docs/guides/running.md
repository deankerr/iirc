# Running the Daemon

The Daemon is one executable, `iirc`, run as a systemd user service (RUN-1). Everything after the first key goes through its API, and `iirc config`, `iirc credential`, and `iirc backup` are Frontends of that API, reading the key from `IIRC_KEY`.

## Install

Build the executable and put it, and the service template, where the user manager looks:

```sh
bun run build
install -Dm755 apps/iirc/dist/iirc ~/.local/bin/iirc
install -Dm644 packaging/systemd/iirc@.service ~/.config/systemd/user/iirc@.service
systemctl --user daemon-reload
```

Each instance is a separate Daemon with its own Log. Instance `main` keeps its data in `~/.local/state/iirc/main` and reads its environment from `~/.config/iirc/main.env`, which must exist:

```sh
mkdir -p ~/.config/iirc
echo IIRC_HTTP_PORT=7667 > ~/.config/iirc/main.env
```

The API listens on loopback only (AUTH-5). Reach it from elsewhere through a tailnet or a reverse proxy.

## The first key

A fresh Daemon has no way to know anyone, so the first key comes from a local command that writes to the Log itself (AUTH-4). Run it before the first start, or with the instance stopped:

```sh
IIRC_DATA_DIR=~/.local/state/iirc/main iirc key create --name owner
```

It prints the key once. Keep it, then start the instance, and have it start at login:

```sh
systemctl --user enable --now iirc@main
export IIRC_KEY=iirc_...
curl -s -H "Authorization: Bearer $IIRC_KEY" http://127.0.0.1:7667/api/status
```

Later keys come from `POST /api/keys`, each with a scope of `read`, `chat`, or `admin` (AUTH-3).

## Add a Network

Write Configuration as TOML and import it, which replaces all of Configuration as one Change (CONF-6). `iirc config export` prints what is there now in the same form.

```toml
[networks.libera]
name = "Libera Chat"
connectCommands = ["MODE iirc +i"]

[networks.libera.identity]
nick = "iirc"

[[networks.libera.ircds]]
host = "irc.libera.chat"
port = 6697

[networks.libera.credentials.service]
password = "libera.nickserv"

[[networks.libera.channels]]
name = "#iirc"
```

```sh
iirc config import libera.toml
```

`POST /api/networks` adds one Network without touching the rest.

## Credentials

Configuration names Credentials and never holds them (CRED-1). Set each value through the API, from stdin, or typed unseen at a terminal:

```sh
iirc credential set libera.nickserv
printf '%s' "$PASSWORD" | iirc credential set libera.pass
cat client.pem | iirc credential set libera.cert
iirc credential list
```

- `credentials.password` is sent as `PASS`, `credentials.service` as `IDENTIFY` to `NickServ` after the burst, and `credentials.clientCertificate` is a PEM with the certificate and its key, which needs TLS on every Ircd.
- A connect command refers to a Credential as `{{name}}`.
- A Network that names a Credential nobody has set makes no Connection, and `/api/status` lists the name under `missingCredentials`. Setting it connects at once.
- A Channel key given to Join is stored as a Credential. Only the Owner changes it: a `MODE +k` on the Network changes nothing, so if an operator changes the key, the next rejoin is refused with `475` until you Join with the new one.

Values live in the system keyring where there is one, and otherwise in `credentials.json` in the data directory with mode `0600`. `/api/status` says which. A file any looser stops the Daemon from starting. A Line the Daemon builds from a Credential is recorded with the value as `<redacted>`. The Daemon never searches other Lines for values, so one that reaches the Log another way, such as a password pasted into a Channel or said back by an Ircd, is recorded as it was said. An `admin` key can remove it with `POST /api/entries/{sequence}/redact` (LOG-7).

## Backup

```sh
iirc backup
```

It writes a copy of the Log into `backups/` in the data directory while the Daemon runs, and says where (RUN-2). A backup holds no Credential, so keep the keyring or `credentials.json` safe as well. An upgrade that migrates the Log takes a backup of its own first (RUN-5).

## Stop and restart

`systemctl --user stop iirc@main` says `QUIT` on every Network, records that the Daemon stopped, and exits 0 (RUN-3). If the process dies, systemd starts it again, and the Log records the Gap as "the Daemon was killed". Reconnect backoff is read from the Log, so a crash loop cannot hammer a Network (LIVE-4).
