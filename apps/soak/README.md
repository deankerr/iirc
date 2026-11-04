# iirc-soak

The soak test's harness (PROOF-5): a Frontend of two Daemons that sends one counted Message a minute through one, and checks the other's Log for every one. It uses only the API, with keys.

- **Depends on:** `@iirc/api` (the client), `@iirc/state` (the same Session fold the Daemon uses, to see its `JOIN` echoed, and casefolding), `@iirc/protocol` (parsing Lines), `effect`, `@effect/platform-bun`.
- **Used by:** the `iirc-soak-send` and `iirc-soak-check` systemd timers. [The soak guide](../../docs/guides/soak.md) sets them up and says how to read the results.

## Commands

| Command | Does |
| --- | --- |
| `iirc-soak send --daemon <url> --pair <network>=<target>...` | Sends `soak <minute> <millis>` to each pair's Target through `POST /api/messages`. Keeps no state. Reads `IIRC_KEY` |
| `iirc-soak check --sender <url> --receiver <url> --pair <sender>:<receiver>=<target>... [--report <file>] [--settle 120] [--silence 10]` | Reads both Logs in full and judges every pair. Keeps no state. Reads `IIRC_SENDER_KEY` and `IIRC_RECEIVER_KEY` |

`check` exits 1 on anything unexplained, duplicated, received but never sent, or silent, and 3 if it could not read a Log.

## How it is built

| Module | Role |
| --- | --- |
| `soak-text.ts` | The counted Message's text, and reading it back exactly |
| `send.ts` | One run of `send` |
| `log-reading.ts` | Pages a Log through the API from one moment: the newest sequence first, then only Entries up to it |
| `folding.ts` | One pass over a Log's Entries that keeps only counted Messages, Self's nick, and what bounds each Gap |
| `verdict.ts` | Judges one pair from the evidence: delivered, explained, missing, duplicated, or silent. Pure |
| `render.ts`, `failure.ts` | The journal line, the JSON report line, and errors |
| `check.ts`, `main.ts` | Wiring and the CLI |

## Key ideas

- **Stateless.** `send` derives each Message's identity from the clock, and `check` derives everything from the Logs, so a restore or a second run cannot confuse either.
- **A Message is its identity,** `<minute> <millis>`. Two runs in one minute send two Messages, and the checker reports that without failing.
- **Explained means the Logs say why.** A missing Message is explained by a Dropped Entry for it, or a Gap on either side covering when it was sent. A Gap's window runs from the last inbound Line before it to the echo of the Daemon's own `JOIN` after it, with no padding.
- **Names compare as the Network compares them,** through `@iirc/state`'s `casefold` under the `CASEMAPPING` the Connection was told.
- **Memory is bounded by counted Messages,** not by the Log: the fold drops every other Entry as it passes.

## Tests

- `verdict.test.ts`, `folding.test.ts`, and the other unit tests run on built evidence.
- `soak.test.ts` runs two real Daemons on a private ngircd, end to end.

## Traps

- A check that runs before the first minute's send fails as silent.
- Stopping the sender for more than `--silence` minutes fails every later check, because silence is derived from history.

## Requirements

PROOF-5 in [Proof](../../docs/requirements.md#proof). It reads LIVE-10's Gaps and SEND-4's Dropped Entries.
