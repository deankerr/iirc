# Proportionate security

The threat model is hostile Networks and hostile text, not the Owner's own software or agents. Anyone on a Network can send the Daemon bytes, and anyone can write text that a Frontend renders or an agent reads, so that is where defence goes. Everything else on the Owner's machine runs for the Owner, and the Credentials iirc holds, such as a NickServ password, are almost valueless. Defending against our own processes would cost complexity everywhere and protect little.

## Consequences

- Hostile input stays a first-class concern: bytes become types at the boundary, nothing a participant sends is an instruction, TLS is the default, and a browser never holds a key in script.
- API keys have three coarse scopes, `read`, `chat`, and `admin`. Keys are not limited per Network or per operation.
- A key is 256 random bits, so the Daemon keeps only its SHA-256 and not a password hash. `Bun.password` cost 117 ms per verify, which a random key does not need.
- Credentials are kept out of the Journal by marking the Lines built from them, not by searching text for them ([ADR 0008](0008-credentials-are-held-not-hunted.md)), and they stay `Redacted` in memory, because the Journal is read by Frontends and copied by backups. Where there is no keyring, they sit in a plain `credentials.json` with mode `0600`. There is no sealed file and no dedicated Unix user.
- The API listens on loopback and does not terminate TLS. `iirc key create` trusts whoever can write the data directory.
