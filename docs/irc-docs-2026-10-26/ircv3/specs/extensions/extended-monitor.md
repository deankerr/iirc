> Source: https://ircv3.net/specs/extensions/extended-monitor Captured: 2026-10-26

# `extended-monitor` Extension

Copyright © 2021 Simon Ser \<contact@emersion.fr>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

**Extends:** [Monitor](monitor.md), [away-notify](away-notify.md), [account-notify](account-notify.md), [chghost](chghost.md), [setname](setname.md)

---

<a id="description"></a>

## Description [🔗](#description)

With the help of extensions such as [`away-notify`](away-notify.md), [`account-notify`](account-notify.md), [`chghost`](chghost.md) and [`setname`](setname.md), clients are able to keep other users’ metadata up-to-date with their local state when they share a channel. However, clients are not able to do so when they don’t share a channel.

The [`monitor`](monitor.md) extension allows clients to track when another user goes offline or comes online. This specification extends MONITOR to also include AWAY, ACCOUNT, CHGHOST and SETNAME notifications.

The `extended-monitor` capability advertises that the server supports sending such extended notifications for monitored nicks. When enabled by the client:

- If `away-notify` is also enabled, the client will get AWAY notifications for monitored nicks.
- If `account-notify` is also enabled, the client will get ACCOUNT notifications for monitored nicks.
- If `chghost` is also enabled, the client will get CHGHOST notifications for monitored nicks.
- If `setname` is also enabled, the client will get SETNAME notifications for monitored nicks.

<a id="privacy-considerations"></a>

## Privacy considerations [🔗](#privacy-considerations)

This extension allows users to monitor personal information of other users. Since the IRC protocol doesn’t provide any way to atomically change this personal information (nick, host, realname all at the same time), it may be possible for an outside observer to track nick changes:

- Observer monitors nick A and nick B.
- User with nick A changes their nick to nick B, then changes their host and realname.
- Observer receives `RPL_MONOFFLINE` for nick A, `RPL_MONONLINE` for nick B, and then receives notifications for host and realname changes.

In this scenario, it’s possible for the observer to figure out that nick A and nick B are owned by the same user by comparing the host and realname.

For this reason, privacy conscious clients are advised to disconnect and re-connect to the IRC server as a way to atomically update personal information.

---

Software supporting extended-monitor: [Ergo](https://ergo.chat/), [InspIRCd](https://www.inspircd.org), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [senpai](https://git.sr.ht/~delthas/senpai), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [Eggdrop](https://github.com/eggheads/eggdrop), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib)
