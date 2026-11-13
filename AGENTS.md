# iirc

@GLOSSARY.md @VISION.md

# Bun

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

# Ultracite

This project uses Ultracite with Oxlint + Oxfmt and Lefthook to enforce strict code quality standards through robust linting, type checking, and formatting. Most issues are automatically fixable.

- **Format code**: `bunx ultracite fix`
- **Check for issues**: `bunx ultracite check`
- **Diagnose setup**: `bunx ultracite doctor`

# Determinism

`@iirc/protocol`, `@iirc/client`, `@iirc/timelines`, and `@iirc/frontend` are pure functions of their inputs. They never read the clock, randomness, the locale, the time zone, the environment, or the world, and their state holds only plain data: strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. The Runtime reaches the world only through its ports, reads time only through Effect's `Clock`, and takes randomness only from Effect's `Random`.

The lint fence in `oxlint.config.ts` catches the obvious slips by name, such as `Date.now()`, `console`, or an import of an adapter or a test kit. It is deliberately small. Review catches the rest, and the transcript test kit's replay law proves it. A gap the fence misses is fixed in the code and named in review, not added to the fence.

# Reference Repos

When writing Effect code, inspect `~/code/ref/effect` for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect v4 patterns.

Additional examples/patterns:

- Effect Solutions `~/code/ref/effect-solutions`
- Rat Stack `~/code/ref/rat-stack`
- IRC clients to compare approaches with: WeeChat `~/code/ref/weechat` (C), Halloy `~/code/ref/halloy` (Rust)

# Docs

The docs are a tree, not a wiki. This file is the root for agents, and `README.md` is the root for people. Find the rest by path and by search.

- `GLOSSARY.md` and `VISION.md`, above, are sources of truth the codebase implements.
- `README.md` holds the one index, of every package and root document.
- `ARCHITECTURE.md` says how the pieces fit and where to extend each. `ROADMAP.md` says what is intended and in what order, and `KNOWN-ISSUES.md` what is built but not yet right.
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

# Work

- **`ROADMAP.md` says what is intended, and an issue is the work.** A feature is specified in an issue and broken into tickets. Each ticket is a vertical slice through the contract, the Client or Daemon, and the web frontend, which can be shown working alone, and it names the tickets that block it.
- **What must be settled first is an issue too:** a question to research, a prototype to react to, or a decision to talk through. It blocks the work that waits on it.
- **Take up only what is labelled `ready-for-agent`,** unless asked. An issue without that label is intended, not ready.
- **Research and a prototype answer their issue,** in a comment or on a branch the issue points at, which is never merged.
- **A defect someone means to fix is an issue.** `KNOWN-ISSUES.md` describes what is built as it is, whether or not anyone means to change it.

# Working in this repository

- A feature exists when its scenarios pass.
- Decide from the protocol's structure, never from an Ircd's free text. Ergo and ngircd are examples of what the protocol allows, not the cases to code for.
- Before finishing, run `bun run check`, `bun run knip`, and `bun run test`. Run `bun run e2e` as well after changing the Transport, the Runtime, pacing, or the Daemon. Its Ircds are private, on loopback ports the kernel picks, and never on port 6667.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
