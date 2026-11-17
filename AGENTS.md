# iirc

@GLOSSARY.md @VISION.md

# Checks

Formatting is automatic: a commit fixes and re-stages its own files. A push runs `bun run check`, `bun run knip`, and `bun run test`, and CI runs them again on the pull request.

One test file runs from the root, as `bun --bun vitest run packages/outbox/src/outbox.test.ts`. An end-to-end file runs only from inside its package, as `cd packages/daemon && bun --bun vitest run src/e2e/uploads.test.ts`, and `apps/iirc`'s need `bun run build:web`, at the root, first. `bun run e2e` runs them all. End-to-end tests run in neither the hooks nor CI. A change to the Transport, the Runtime, pacing, or the Daemon runs them, and gives the run as evidence. A Frontend change gives failing-first fake-Daemon tests and screenshots instead.

A flaky end-to-end test is quarantined, never rerun until it passes: fix its cause, or file a `bug` issue for it and skip it with a comment linking that issue.

# Determinism

`@iirc/protocol`, `@iirc/client`, `@iirc/timelines`, and `@iirc/frontend` are pure functions of their inputs. They never read the clock, randomness, the locale, the time zone, the environment, or the world, and their state holds only plain data: strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. The Runtime reaches the world only through its ports, reads time only through Effect's `Clock`, and takes randomness only from Effect's `Random`.

The lint fence in `oxlint.config.ts` catches the obvious slips by name, such as `Date.now()`, `console`, or an import of an adapter or a test kit. It is deliberately small. Review catches the rest, and the transcript test kit's replay law proves it. A gap the fence misses is fixed in the code and named in review, not added to the fence.

# Docs

The docs are a tree, not a wiki. This file is the root for agents, and `README.md` is the root for people. Find the rest by path and by search.

- `GLOSSARY.md` and `VISION.md`, above, are sources of truth the codebase implements.
- `README.md` holds the one index, of every package and root document.
- `ARCHITECTURE.md` says how the pieces fit, and `KNOWN-ISSUES.md` what is built but not yet right. What is intended is the open issues.
- `docs/adr/` holds the decisions, which the codebase implements too.
- `docs/agents/` tells the agent skills where issues live, what each label means, and how to read these documents.
- A package's README is its interface: what it is for, how a caller uses it, what it guarantees, and what it does not do yet. Read it before changing the package, and keep it true in the same commit.

Keeping them clean:

- **No links between documents.** Name a package or a path in backticks only where a reader needs it. The one exception is an ADR linking another ADR.
- **`GLOSSARY.md` and `VISION.md` point at nothing,** and nothing else explains them. A term is settled in `GLOSSARY.md` before it is used anywhere else.
- **Name an ADR only where a choice would surprise a reader.** An ADR mentions no document but another ADR.
- **A README describes its own package,** never another package, and never itself or where its types are.
- **Say a thing once, in the document that owns it.** Do not repeat it elsewhere, and do not add a second index.
- **Keep it short.** A README reads in one sitting. The exact types stay in `src/`, each edge case in a test named for it, and the reason for a choice in a comment beside the code or in an ADR. A README never lists what the tests cover.
- **Rewrite, do not append.** A change rewrites the entry it touches, and adds one only for a new part of the interface.

# Working in this repository

- A feature exists when its scenarios pass.
- Decide from the protocol's structure, never from an Ircd's free text. Ergo and ngircd are examples of what the protocol allows, not the cases to code for.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
