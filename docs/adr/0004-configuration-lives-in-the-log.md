# Configuration lives in the Log

Configuration is a projection of Change Entries, and TOML is only a way to read and write it: `iirc config export` produces a file, and `iirc config import` applies one as a single Change. A file the Daemon obeyed was the obvious choice for a server, but past state could then only be derived by recording each version of the file, and the API and the Owner's editor would be two writers of one document, with a plain rewrite dropping the Owner's comments.

## Consequences

The Daemon never reads a config file at startup and never watches or rewrites one, so a fresh Daemon needs only a data directory and a listen address (CONF-4). Editing a live Daemon's Configuration through a file is a deliberate export, edit, and import rather than a save. A file's comments do not survive that round trip, and Bun's `TOML.stringify` does the writing because Effect's `Toml` only parses.
