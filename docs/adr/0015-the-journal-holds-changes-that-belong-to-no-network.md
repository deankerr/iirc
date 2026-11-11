# The Journal holds Changes that belong to no Network

Some Configuration belongs to the Owner rather than to any Network, such as how Frontends look: the theme, how times are shown, and the keymap ([ADR 0013](0013-configuration-is-an-option-tree.md)). It is recorded in the Journal as a `Change` record that names no Network, so it is shared by every device, survives restarts, and can be read at any past sequence like everything else. A separate settings file would have been simpler, but it would be a second source of truth beside the Journal, and its history would be lost.

## Consequences

- `JournalRecord` gains `Change { change }`, which the Runtime never steps through a Client. The Daemon folds Changes into the Owner's Configuration, as a projection, and the API reads and sets it as options under `ui`.
- The `ui` options' Schema lives in the contract, `@iirc/api`, so every Frontend reads the same options, and the Daemon parses a value before it is journaled. A Frontend may still keep a per-device override, which it never sends.
- A Change is the whole value of one option, so applying it twice is applying it once, and the latest for an option wins.
- Keys and sign-ins may move into Changes later. They stay in their files for now.
