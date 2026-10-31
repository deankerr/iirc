> Source: https://ircv3.net/specs/extensions/away-notify Captured: 2026-10-26

# `away-notify` Extension

Copyright © 2012 Keith Buck \<mr\_flea@esper.net>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

The away-notify client capability allows a client to specify that it would like to be notified when users are marked/unmarked as away. This capability is referred to as ‘away-notify’ at capability negotiation time.

This capability is designed to replace polling of WHO as a more efficient method of tracking the away state of users in a channel. The away-notify capability both conserves bandwidth as WHO requests are not continually sent and allows the client to be notified immediately upon a user setting, changing or removing their away state (as opposed to when WHO is next polled).

When this capability is enabled, clients will be sent an AWAY message when a user sharing a channel with them sets, changes or removes their away state, as well as when a user joins and has an away message set. (Note that AWAY will not be sent for joining users with no away message set.)

Clients SHOULD NOT be sent AWAY messages to notify them of their own away status (as they can rely on `RPL_NOWAWAY` and `RPL_UNAWAY`).

The format of the AWAY message is as follows:

```
:nick!user@host AWAY [:message]
```

If the message is present, the user (specified by the nick!user@host mask) is going away. If the message is not present, the user is removing their away message/state.

To fully track the away state of users, clients should:

1. Enable the away-notify capability at negotiation time.

2. Execute WHO when joining a channel to capture the current away state of all users in that channel.

3. Update state appropriately upon receiving an AWAY message.

<a id="erratum"></a>

## Erratum [🔗](#erratum)

The previous version of this specification did not explicitly say users should not get notifications of their own away status with AWAY. This was clarified in 2023

---

Software supporting away-notify: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Planio Team Chat](https://plan.io/business-chat/), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [Swirc](https://www.nifty-networks.net/swirc/), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [BitlBee](https://bitlbee.org/), [j2i](https://telepath.im/projects/j2i/), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
