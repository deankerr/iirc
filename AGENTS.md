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

`@iirc/protocol` and `@iirc/client` are pure functions of their inputs. They never read the clock, randomness, the locale, the time zone, the environment, or the world, and Client state holds only plain data: strings, numbers, booleans, arrays, plain objects, `Map`, and `Set`. The Runtime reaches the world only through its ports, reads time only through Effect's `Clock`, and takes randomness only from Effect's `Random`.

The lint fence in `oxlint.config.ts` catches the obvious slips by name, such as `Date.now()`, `console`, or an import of an adapter or a test kit. It is deliberately small. Review catches the rest, and the transcript test kit's replay law proves it. A gap the fence misses is fixed in the code and named in review, not added to the fence.

# Reference Repos

When writing Effect code, inspect `~/code/ref/effect` for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect v4 patterns.

Additional examples/patterns:

- Effect Solutions `~/code/ref/effect-solutions`
- Rat Stack `~/code/ref/rat-stack`
- IRC clients to compare approaches with: WeeChat `~/code/ref/weechat` (C), Halloy `~/code/ref/halloy` (Rust)

# Working in this repository

- [`docs/architecture.md`](docs/architecture.md) is the map, and says where to extend each part. Each package's README is its written interface: read it before changing the package, and change it in the same commit.
- A feature exists when its scenarios pass. Write it down in the module's README, from the floor up, as the existing entries are.
- Decide from the protocol's structure, never from an Ircd's free text. Ergo and ngircd are examples of what the protocol allows, not the cases to code for.
- Before finishing, run `bun run check`, `bun run knip`, and `bun run test`. Run `bun run e2e` as well after changing the Transport, the Runtime, pacing, or the Daemon. Its Ircds are private, on loopback ports the kernel picks, and never on port 6667.
