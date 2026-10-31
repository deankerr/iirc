> Source: https://ircv3.net/specs/extensions/userhost-in-names Captured: 2026-10-26

# `userhost-in-names` Extension

Copyright © 2013 Mantas Mikulėnas \<grawity@gmail.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

The `userhost-in-names` capability extends the NAMES reply messages (`RPL_NAMREPLY`) to contain the full hostmask (nick!user@host) of every user listed.

Example:

```
--> NAMES #atheme
:irc.bnc.im 353 guest = #atheme :Rylee!rylai@localhost somasonic!andrew@somasonic.org
:irc.bnc.im 366 guest #atheme :End of /NAMES list
```

Historical note: Some older (pre-IRCv3) software implements the same extension as `PROTOCTL UHNAMES` and advertises it using the `UHNAMES` token in `RPL_ISUPPORT`; some implementations support enabling the same capability using either CAP or PROTOCTL. New servers or clients SHOULD NOT implement the PROTOCTL method, although they may still do so for compatibility with older software.

---

Software supporting userhost-in-names: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [BitlBee](https://bitlbee.org/), [Matrix2051](https://github.com/progval/matrix2051), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
