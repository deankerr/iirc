# Credentials are held, not hunted

A Credential is a secret the Owner gives the Daemon to use on their behalf. Nothing a Network sends is one. A Channel key seen in a `MODE` is already known to the Ircd and every member, was chosen by someone else, and may not even be the key: the Daemon reads it through its own model of the Network's modes, an Ircd may mask or alter it, and a netsplit can leave a different key standing. Storing it as a secret promoted a guess to the Owner's own secret, and let anyone with operator status choose a word for the Daemon to erase.

The Daemon protects a Credential by never writing it down. The code that puts a Credential into a Line is the only code that knows where it went, so that Line is recorded with the value replaced where it was placed, and the Entry names which Credential stood there. The Daemon does not search text for the values it holds. Scrubbing by value deleted ordinary words, let the words around a placeholder reveal what it hid, crossed from one Network's Credentials into another's Lines, and could not see a value once it had been encoded, as SASL encodes a password.

Everything else the Journal holds is the Owner's private data, not a secret. Messages, Direct Messages, and our own host are protected by who can read the Journal, through API keys and file permissions, and never by redaction. A value the Daemon checks rather than uses, such as an API key, is kept only as a hash.

## Consequences

- A secret that gets through by the Owner's own hand, such as a password pasted into a Channel or sent as a raw Line, is recorded as it was sent, and removed by redaction. This follows [ADR 0006](0006-proportionate-security.md): the Owner's own actions are not the threat.
- Channel keys come only from the Owner. A Join refused for a wrong key is reported, and the Owner supplies the new one. `+k` and `-k` are recorded as ordinary Lines, and the Daemon takes no action on them.
- An Entry's names say what was redacted, not its text. A User who sends the literal `<redacted>` redacts nothing.
- Each new feature that sends a Credential builds its Lines through code that marks them, and adds nothing to a search.
