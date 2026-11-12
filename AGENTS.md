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
- `ARCHITECTURE.md` says how the pieces fit and where to extend each. `ROADMAP.md` says what is next, and `KNOWN-ISSUES.md` what is built but not yet right.
- `docs/adr/` holds the decisions, which the codebase implements too.
- A package's README is its interface: what it is for, how a caller uses it, what it guarantees, and what it does not do yet. Read it before changing the package, and keep it true in the same commit.

Keeping them clean:

- **No links between documents.** Name a package or a path in backticks only where a reader needs it. The one exception is an ADR linking another ADR.
- **`GLOSSARY.md` and `VISION.md` point at nothing,** and nothing else points at them or explains them.
- **Name an ADR only where a choice would surprise a reader.** An ADR mentions no document but another ADR.
- **A README describes its own package,** never another package, and never itself or where its types are.
- **Say a thing once, in the document that owns it.** Do not repeat it elsewhere, and do not add a second index.
- **Keep it short.** A README reads in one sitting. The exact types stay in `src/`, each edge case in a test named for it, and the reason for a choice in a comment beside the code or in an ADR. A README never lists what the tests cover.
- **Rewrite, do not append.** A change rewrites the entry it touches, and adds one only for a new part of the interface.

# Working in this repository

- A feature exists when its scenarios pass.
- Decide from the protocol's structure, never from an Ircd's free text. Ergo and ngircd are examples of what the protocol allows, not the cases to code for.
- Before finishing, run `bun run check`, `bun run knip`, and `bun run test`. Run `bun run e2e` as well after changing the Transport, the Runtime, pacing, or the Daemon. Its Ircds are private, on loopback ports the kernel picks, and never on port 6667.
