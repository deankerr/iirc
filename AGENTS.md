# iirc

@GLOSSARY.md @VISION.md

# Tests

The brief says what to run. By hand, run `bun --bun vitest related <files> --run`; the full suite belongs to the push, since two at once starve each other.

`bun run e2e` runs in neither the hooks nor CI. Run it, and cite the run as evidence, when a change touches the S3 byte store, image stripping, the Bun link fetch, or how `iirc` is compiled, serves the web frontend, or stops.

A test earns its place by catching a regression no other test catches, one a Frontend, the Owner, or a Network would notice. Name that regression first.

- **Test a decision where it is made:** the pure package has a row per branch; the layers above show it is wired in.
- **Assert what a caller sees,** not private state, internal call order, or wording nothing depends on.
- **Harden against a Network or a fetched page,** not the Owner's input.
- **Load must not change a result.** Wait for a condition, not a duration; hold the clock where time matters; compare two cases rather than bound one; show nothing happened by what happened next. A timeout only catches a hang.
- **Print nothing.** Delete a test with what it tested.
- **Quarantine a flaky test,** end-to-end too: fix it, or skip it with a comment linking its `bug` issue. Never rerun until it passes.

# Determinism

`@iirc/protocol`, `client`, `outbox`, `timelines`, and `frontend` are pure: no clock, randomness, locale, time zone, environment, or I/O, and their state is plain data (primitives, arrays, plain objects, `Map`, `Set`). The Runtime reaches the world only through its ports, time only through Effect's `Clock`, and randomness only through Effect's `Random`.

# Docs

`GLOSSARY.md`, `VISION.md`, and `docs/adr/` are sources of truth. A package's README is its interface: read it before changing the package, and keep it true in the same commit.

- **Say a thing once,** in the document that owns it. The root `README.md` is the one index.
- **No links between documents.** Name a path in backticks. An ADR may link another ADR, and is named only where a choice would surprise.
- **`GLOSSARY.md` and `VISION.md` point at nothing,** and nothing else explains them. Settle a term in `GLOSSARY.md` before using it elsewhere.
- **Describe what is; rewrite, don't append.** Exact types live in `src/`, an edge case in a test named for it, a reason in a comment by the code or in an ADR.
- **An ADR states a decision and its reason,** may lead the code, and lists nothing the code lists: no commands, flags, or counts.
- **A README bullet is one behaviour a caller can rely on,** in a sentence or two.
- **"Not yet"** names, once and in the package that would do it, what a caller would otherwise assume. Intended work is an issue.

# Copy

User-facing copy is plain, contemporary US English: direct, calm, active, addressing the user as "you". Lead with what happened or what to do, in one or two short sentences, using standard UI verbs (`loading…`, `save`, `set` / `not set`, `shared in`, `leave`, `current`, `monospace`).

- **Vocabulary:** glossary terms in lowercase, with their `_UI_:` overrides. Say `daemon` only to tell it apart from an IRC server or browser.
- **Casing:** lowercase for UI labels (nav, headings, pane titles, buttons, menus, fields, badges); sentence case for prose (dialogs, empty states, helper text, notices, command and option descriptions, activity lines, logs). Tooltips and `aria-label`s follow their element.
- **Units:** decimal file sizes: `B`, `KB`, `MB`, `GB`, `TB`.
- **Web UI vs. logs and CLI:** the web UI translates internals (`journaled`, `folded`) and protocol tokens (`ISUPPORT`, `PREFIX`) into what the user sees. Logs (`/logs`, stdout) and CLI errors may use operational terms (`daemon`, `journal`, `vault`, `credential`, `TLS`, `SASL`, `SQLite`, `S3`), and CLI errors must hold for a release binary.

# Agent skills

## Issue tracker

GitHub Issues. See `docs/agents/issue-tracker.md`.

## Triage labels

See `docs/agents/triage-labels.md`.

## Domain docs

Single-context. See `docs/agents/domain.md`.

## Pull requests

Open every pull request with the `pr` skill.
