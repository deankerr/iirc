# Domain Docs

How the engineering skills consume this repo's domain documentation.

## Before exploring

- `GLOSSARY.md` is already loaded through `AGENTS.md`.
- Read the ADRs in `docs/adr/` that touch the area you are about to work in.

## Use the glossary's vocabulary

When your output names a domain concept—in code, APIs, issue titles, proposals, hypotheses, or test names—use the primary term as `GLOSSARY.md` defines it, never one it says to avoid.

In user-facing UI copy, use a term's `_UI_:` wording from `GLOSSARY.md` when one is listed (even if that word appears in `_Avoid_:` for code and docs).

If the concept you need is not in the glossary, either you are inventing language the project does not use, or there is a real gap to raise.

## Flag ADR conflicts

If your output contradicts an ADR, say so plainly instead of overriding it silently.
