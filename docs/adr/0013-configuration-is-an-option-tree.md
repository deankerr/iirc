# Configuration is an option tree

Every piece of Configuration is an option with a dotted name, such as `network.libera.nick`, and its type, default, and description come from the annotations on the contract's Schemas. Any Frontend can then list, read, and set any option without a form built for it, much as WeeChat's `/set` and `/fset` do. A new field becomes a new option with no work in any Frontend. The Owner never edits a file or sets an environment variable for common Configuration: the Daemon's only flags are its data directory and the address it listens on.

## Consequences

- The web frontend has two generic ways in: `/set`, `/unset`, and `/set <pattern>` from the composer or the palette, and an options pane that filters as you type and edits each value in place.
- A write changes one option and sends the whole Configuration, as [ADR 0004](0004-configuration-lives-in-the-journal.md) and the Client already require. It names the sequence it was read at, and the Daemon refuses it if the Configuration has changed since, so two Frontends editing at once cannot silently overwrite each other.
- A Credential option is write-only. Setting it holds the value in the Vault, and it shows as held, never as its value.
- Options for Frontends, such as the theme, the keymap, and how times are shown, live in the same tree under `ui`. They are Changes shared by every device, and a device may override any of them for itself.
