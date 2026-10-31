> Source: https://ircv3.net/specs/extensions/no-implicit-names Captured: 2026-10-26

# `no-implicit-names` Extension

Copyright © 2023 Simon Ser \<contact@emersion.fr>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

This document describes the `no-implicit-names` extension. This allows clients to opt-out from the implicit `NAMES` reply servers send after `JOIN` messages.

Some clients don’t need to query the list of channel members for all joined channels. Omitting this information can reduce the time taken to connect to the server, especially on mobile devices and when a large number of channels are joined.

<a id="implementation"></a>

## Implementation [🔗](#implementation)

The `no-implicit-names` extension introduces the `no-implicit-names` capability. When negotiated, servers MUST NOT send an implicit `NAMES` reply after sending a `JOIN` message. Servers MUST reply to explicit `NAMES` commands sent by the client as usual.

---

Software supporting no-implicit-names: [InspIRCd](https://www.inspircd.org), [Solanum](https://github.com/solanum-ircd/solanum), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [Obby](https://github.com/obbyworld/obby)
