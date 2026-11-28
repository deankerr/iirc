# iirc

@GLOSSARY.md @VISION.md

# Tests

The brief says what to run. A run by hand covers the files a change reaches, as `bun --bun vitest related <files> --run`. The whole suite is the push's, since two at once starve each other.

End-to-end tests run in neither the hooks nor CI. A change to the S3 byte store, image stripping, the Bun link fetch, or how `iirc` is compiled, serves its web frontend, or stops, runs `bun run e2e`, and gives the run as evidence.

A test earns its place by the regression it alone catches, one a Frontend, the Owner, or a Network would notice. Name it before writing the test. If another test already fails on it, write nothing.

- **Test a decision where it is made.** A pure package covers the cases, a row for each branch. The layers above show it is wired in.
- **Assert what a caller sees,** not private state, the order of calls inside, or wording nothing depends on.
- **Harden against a Network or a fetched page,** not the Owner's own input.
- **A busy machine must not change a result.** Wait for a condition rather than a length of time, hold the clock where time matters, and compare two cases rather than bound one. Show that nothing happened by what happened next. A timeout is only for a hang.
- **Print nothing,** and delete a test with what it tested.
- **A flaky test is quarantined,** end-to-end ones too: fixed, or skipped with a comment linking its `bug` issue. It is never rerun until it passes.

# Determinism

`@iirc/protocol`, `@iirc/client`, `@iirc/outbox`, `@iirc/timelines`, and `@iirc/frontend` are pure functions of their inputs. They never read the clock, randomness, the locale, the time zone, the environment, or the world, and their state holds only plain data: strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. The Runtime reaches the world only through its ports, reads time only through Effect's `Clock`, and takes randomness only from Effect's `Random`.

# Docs

`GLOSSARY.md`, `VISION.md`, and `docs/adr/` are sources of truth the codebase implements. A package's README is its interface: read it before changing the package, and keep it true in the same commit.

- **Say a thing once, in the document that owns it.** A README describes its own package. `README.md` at the root holds the one index.
- **No links between documents.** Name a path in backticks where a reader needs it. An ADR may link another ADR, and is named only where a choice would surprise a reader.
- **`GLOSSARY.md` and `VISION.md` point at nothing,** and nothing else explains them. A term is settled in `GLOSSARY.md` before it is used anywhere else.
- **Describe what is, and rewrite rather than append.** Exact types stay in `src/`, an edge case in a test named for it, and the reason for a choice in a comment beside the code or in an ADR.
- **An ADR states a decision and its reason,** and may lead the code. It lists nothing the code lists: no commands, flags, or counts.
- **A README bullet is one behaviour a caller can rely on,** in a sentence or two.
- **"Not yet" names what a caller would otherwise assume the package does,** once, in the package that would do it. Work someone means to do is an issue.

# Copy

User-facing copy is written in plain, contemporary US English: direct, calm, and active. Address the user as "you" and "your". Lead with what happened or what to do in one or two short sentences, using standard UI verbs (`loading…`, `save`, `set` / `not set`, `shared in`, `leave`, `current`, `monospace`).

- **Vocabulary:** Use `GLOSSARY.md` terms in lowercase, applying every `_UI_:` override in user-facing copy. Use `daemon` when distinguishing it from an IRC server or browser; omit it when obvious.
- **Casing:** Use lowercase for UI labels (sidebar headings and nav items, pane titles, buttons, menus, field labels, status badges, lookup headings, formatting labels). Use sentence case for prose (dialog titles and descriptions, empty states, helper text, notices, command and option descriptions, activity lines, and logs), never capitalizing common nouns mid-sentence. Tooltips and `aria-label`s match their element: lowercase for short action labels, sentence case for full phrases.
- **Units:** Format file sizes in decimal (base 1000) with uppercase units: `B`, `KB`, `MB`, `GB`, `TB`.
- **Web UI vs. logs and CLI:** Web UI copy (notices, errors, dialogs, command help, option descriptions) uses plain end-user language, translating internal mechanics (`journaled`, `folded`) and IRC protocol tokens (`ISUPPORT`, `CHANMODES`, `PREFIX`, `ACCOUNTEXTBAN`) into what the user sees. Daemon/runtime logs (`/tail`, stdout) and CLI errors (`apps/iirc`) use the same plain US English, while allowing operational terms (`daemon`, `journal`, `vault`, `credential`, `TLS`, `SASL`, `SQLite`, `S3`) where they aid debugging; keep CLI errors valid for a release binary.

# Agent skills

## Issue tracker

Issues live in this repo's GitHub Issues, through the `gh` CLI. Read `docs/agents/issue-tracker.md` before filing, reading, linking, or closing one.

## Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Read `docs/agents/triage-labels.md` before labelling an issue.

## Pull requests

Open every pull request with the `pr` skill.

## Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the root. Read `docs/agents/domain.md` before naming a domain concept or contradicting an ADR.
