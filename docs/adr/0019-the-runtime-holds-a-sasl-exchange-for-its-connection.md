# The Runtime holds a SASL exchange for its Connection

`SCRAM-SHA-256` needs the password, a nonce, and three rounds, and checks the Ircd's signature at the end. The Client drives the rounds from the `AUTHENTICATE` Lines it receives and asks for each answer as a `SendSecret`, as `PLAIN` does. The Runtime works out each answer inside an exchange it holds for the Connection: it makes the nonce from Effect's `Random`, derives the proof from the Credential, checks the Ircd's final message, and steps the check's result into the Client as an input. The nonce and the salted password last as long as the Connection, as its socket does, and are never journaled. A replay needs neither, since the Client is rebuilt from the Lines it received and the input that carried the check. This extends [ADR 0008](0008-credentials-are-held-not-hunted.md) from one fill to a short conversation. We chose it over journaling a nonce for the Client to build the first message, which would still have left the proof and the check needing the password outside the Client, and spread one mechanism across both.

## Consequences

- The Client never holds a nonce, a salt, or a proof. It knows only which round it is in.
- A Line the exchange sends is recorded with its answer replaced, as a filled Line is.
- A SCRAM login that fails does not fall back to `PLAIN`, since that would send the password to an Ircd that failed SCRAM.
