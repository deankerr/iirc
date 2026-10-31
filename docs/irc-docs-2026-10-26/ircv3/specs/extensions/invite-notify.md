> Source: https://ircv3.net/specs/extensions/invite-notify Captured: 2026-10-26

# `invite-notify` Extension

Copyright © 2013 Adam \<adam@anope.org>

Copyright © 2014 Attila Molnar \<attilamolnar@hush.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

The `invite-notify` client capability allows a client to specify that it would like to be notified when users are invited to channels.

This client capability MUST be named `invite-notify`.

This capability is designed to replace the traditional “X has invited Y to #chan” server notices, and to provide a standard way that allows clients to learn when another client does an /INVITE.

<a id="format"></a>

## Format [🔗](#format)

The format of the INVITE message is as follows:

```
:<inviter> INVITE <target> <channel>
```

The message source, `inviter` is the user doing the INVITE, target is the user being invited, `channel` is the channel where `target` is being invited.

<a id="example"></a>

## Example [🔗](#example)

```
:ChanServ!ChanServ@example.com INVITE Attila #channel
```

This message translates to ChanServ has invited Attila to #channel.

<a id="notes"></a>

## Notes [🔗](#notes)

The server is not required to send the INVITE message described in this document to all clients supporting this capability on a channel. For example, a server may choose to only send the message to clients having channel op, or only to clients that have the privilege to do an /INVITE on the channel themselves.

---

Software supporting invite-notify: [Ergo](https://ergo.chat/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [Srain](https://srain.silverrainz.me), [Swirc](https://www.nifty-networks.net/swirc/), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [Biboumi](https://biboumi.codeberg.page/), [Matrix2051](https://github.com/progval/matrix2051)
