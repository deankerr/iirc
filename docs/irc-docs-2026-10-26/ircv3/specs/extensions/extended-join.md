> Source: https://ircv3.net/specs/extensions/extended-join Captured: 2026-10-26

# `extended-join` Extension

Copyright © 2011 Kiyoshi Aman \<kiyoshi.aman@gmail.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

The extended-join capability extends the JOIN message to include the account name, or a placeholder if the user hasn’t identified with services. This capability MUST be referred to as ‘extended-join’ at capability negotiation time.

When enabled, the JOIN message will designate the account name of the user when they join a channel.

The JOIN message is one of the following:

```
:nick!user@host JOIN #channelname accountname :Real Name
```

This message represents that the user identified by nick!user@host has logged in to an account prior to channel ingress. The penultimate parameter is the display name of that account. The last parameter is the user’s GECOS.

```
:nick!user@host JOIN #channelname * :Real Name
```

This message represents that the user has not logged in to an account prior to channel ingress. As the penultimate parameter is an asterisk, this means that an asterisk is not a valid account name (which it is not in P10 or TS6 or ESVID).

Please see [`account-notify`](account-notify.md) for information on how to take advantage of this capability.

---

Software supporting extended-join: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [Circe](https://github.com/emacs-circe/circe), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [Swirc](https://www.nifty-networks.net/swirc/), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [BitlBee](https://bitlbee.org/), [Matrix2051](https://github.com/progval/matrix2051), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
