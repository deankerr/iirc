> Source: https://ircv3.net/specs/extensions/account-tag Captured: 2026-10-26

# `account-tag` Extension

Copyright © 2013-2015 Mantas Mikulėnas \<grawity@gmail.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

The `account-tag` capability causes the server to add a [message tag](message-tags.md) containing the command sender’s services account to commands sent to the client that has requested this capability. It supersedes the `identify-msg` extension.

The tag MUST be named `account`, and contain the sender’s current services username. (If the user is not identified to any services account, the tag MUST NOT be sent.)

The tag MUST be added by the ircd to all commands sent by a user (e.g. PRIVMSG, MODE, NOTICE, and all others). The tag also SHOULD be added by the ircd to all numerics directly caused by the sender. For example, if the target user has “caller ID” enabled (e.g. user modes +R or +g in Charybdis), the tag SHOULD be added to numerics indicating blocked message attempts (numeric 718 aka `RPL_UMODEGMSG`).

Example (demonstrated using the `account-notify` capability):

```
<-- :user PRIVMSG #atheme :Hello everyone.
<-- :user ACCOUNT hax0r
<-- @account=hax0r :user PRIVMSG #atheme :Now I'm logged in.
<-- @account=hax0r :user ACCOUNT bob
<-- @account=bob :user PRIVMSG #atheme :I switched accounts.
```

<a id="relationship-to-other-extensions"></a>

## Relationship to other extensions [🔗](#relationship-to-other-extensions)

Rationale: This extension was proposed because `identify-msg` does not always provide enough information (e.g. the user may be logged into a different account); `extended-join` and `account-notify` do not work with private messages (unless both participants share at least one channel) or with messages sent from outside users to a `-n` channel; and `metadata` makes the client actively request someone’s account name (i.e. another client may send a private message and quickly switch accounts before the local client even has a chance to send a metadata query).

This extension supersedes `identify-msg`. This extension does not deprecate `extended-join`, as the latter also extends JOIN to send more information than just the account name. Similarly, this extension does not deprecate `account-notify`, as the latter provides real-time notifications while this extension does not.

<a id="errata"></a>

## Errata [🔗](#errata)

- Earlier version of this specification said that account tags MUST be added to numerics that were directly caused by a specific user. This was relaxed to SHOULD after it was found to be widely not implemented and a problem for existing implementations to implement.

---

Software supporting account-tag: [Codename IRCat](https://ircat.xyz), [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [InspIRCd](https://www.inspircd.org), [juno](https://github.com/cooper/juno), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [Swirc](https://www.nifty-networks.net/swirc/), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [Matrix2051](https://github.com/progval/matrix2051), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
