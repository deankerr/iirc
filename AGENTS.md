# iirc

@GLOSSARY.md @VISION.md

# Bun

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

# Ultracite

This project uses Ultracite with Oxlint + Oxfmt and Lefthook to enforce strict code quality standards through robust linting, type checking, and formatting. Most issues are automatically fixable.

- **Format code**: `bunx ultracite fix`
- **Check for issues**: `bunx ultracite check`
- **Diagnose setup**: `bunx ultracite doctor`

# Reference Repos

When writing Effect code, inspect `~/code/ref/effect` for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect v4 patterns.

Additional examples/patterns:

- Effect Solutions `~/code/ref/effect-solutions`
- Rat Stack `~/code/ref/rat-stack`
- IRC clients to compare approaches with: WeeChat `~/code/ref/weechat` (C), Halloy `~/code/ref/halloy` (Rust)

# Milestone 2's code

The code from milestone 2 was retired on 2026-11-08 and is kept only at the git tag `m2` (read it with `git show m2:<path>`). It is not an interface new work must stay compatible with. Port from it on purpose, with new tests at the new module's interface, and never import it. [The architecture proposal](docs/notes/2026-11-07-architecture-proposal.md) describes the shape we are building.
