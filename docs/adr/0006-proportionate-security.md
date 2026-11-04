# Proportionate security

The threat model is hostile Networks and hostile text, not the Owner's own software or agents. Anyone on a Network can send the Daemon bytes, and anyone can write text that a Frontend renders or an agent reads, so that is where defence goes. Everything else on the Owner's machine runs for the Owner, and the Credentials iirc holds, such as a NickServ password, are almost valueless. Defending against our own processes would cost complexity everywhere and protect little.

## Consequences

- Hostile input stays a first-class concern: bytes become types at the boundary, nothing a participant sends is an instruction (HOST-1 to HOST-4), TLS is the default (CONN-1), and a browser never holds a key in script (AUTH-7).
- API keys have three coarse scopes, `read`, `chat`, and `admin` (AUTH-3). Keys are not limited per Network or per operation.
- A key is 256 random bits, so the Log keeps its SHA-256 and not a password hash (AUTH-2). `Bun.password` cost 117 ms per verify, which a random key does not need.
- Credentials are kept out of the Log (LOG-6) and stay `Redacted` in memory (CRED-3), because the Log is read by Frontends and copied by backups. Where there is no keyring, they sit in a plain `credentials.json` with mode `0600`. There is no sealed file and no dedicated Unix user.
- The API listens on loopback and does not terminate TLS (AUTH-5). `iirc key create` trusts whoever can write the data directory (AUTH-4).
