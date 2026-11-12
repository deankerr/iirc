# The RFC protocol is the floor

iirc gives at least base support to any Ircd that speaks the client protocol of RFC 1459 and RFC 2812, as Modern IRC describes it. On such an Ircd, the Daemon connects, registers, joins Channels, sends and receives Messages, stays connected, and records all of it. No core behaviour depends on an IRCv3 capability. Capabilities are extensions, negotiated and optional by design, so depending on any one of them goes against the intent of the extension mechanism. Some Networks in netsplit.de's top 100 offer no capability negotiation at all.

Beyond the floor, a feature is added when it is judged worth its cost, and the bar is highest for a feature that needs polling. Many capabilities make a fact arrive as a Line that the base protocol could only recover by asking, such as a User's away status, or every prefix a member holds. The Journal is event-sourced, which makes polling dearer for iirc than for most IRC clients. Every reply is recorded and replayed for as long as history is kept, and a guess recorded as fact can't be taken back.

## Consequences

- Without a capability, a fact is less precise or unknown, and says which. Without `multi-prefix`, `NAMES` gives only a member's highest prefix. Without `server-time`, a Message's time is when it arrived.
- Where a capability's absence would leave the Daemon wrong, the floor covers it. Without `echo-message`, our own Messages are recorded from what we sent.
- Behaviour that recovers a fact by polling or guessing is not built by default. Examples are `WHO` polling for away status, and re-reading `NAMES` after a mode change. Each is a feature of its own, added only when judged worthwhile.
- Nothing is decided from free text an Ircd sends. Account login uses SASL, and identifying to a service by reading its replies is not part of the floor.
- Without `chathistory`, anything said while the Daemon is disconnected can't be recovered, and the Gap stays visible.
- Every scenario is tested with no capabilities, and then across combinations of them.
