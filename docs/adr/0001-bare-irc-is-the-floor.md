# Bare IRC is the floor

Every core behaviour must work on a network with no IRCv3 at all, and IRCv3 only improves things when it is detected. The Owner's regular network has no IRCv3, and ngircd offers only `multi-prefix`, so a client that assumes modern capabilities would fail on the networks it is built for.

## Consequences

Without IRCv3 there is no `server-time`, `echo-message`, `labeled-response`, message tags, or `chathistory`. Message times are when we received them, our own outgoing Messages are recorded by us and not echoed back, and anything said while we are disconnected cannot be recovered. A feature that needs one of these capabilities is an enhancement and cannot be load-bearing.
