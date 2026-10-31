> Source: https://ircv3.net/specs/extensions/multi-prefix Captured: 2026-10-26

# `multi-prefix` Extension

Copyright © 2012 William Pitcock \<nenolod@dereferenced.org>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

When requested, the multi-prefix client capability will cause the IRC server to send all possible prefixes which apply to a user in NAMES, WHO and WHOIS output.

These prefixes MUST be in order of ‘rank’, from highest to lowest.

Example:

```
--> NAMES #tethys
:hades.arpa 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
:hades.arpa 366 guest #tethys :End of /NAMES list

--> WHO #test
:kenny.chatspike.net 352 guest #test grawity broken.symlink *.chatspike.net grawity H@%+ :0 Mantas M.
:kenny.chatspike.net 315 guest #test :End of /WHO list

--> WHOIS barmand
:irc.chat 311 guest barmand barmand cosani.jp * :Armand
:irc.chat 319 guest barmand :~&@%+#falco @+#raynor
:irc.chat 312 guest barmand irc.chat :Antibes
:irc.chat 318 guest barmand :End of /WHOIS list
```

<a id="errata"></a>

## Errata [🔗](#errata)

Previous versions of this spec did not specify that all possible prefixes which apply to users be also sent in WHOIS output. This was added for consistency with other replies that contain user prefixes.

---

Software supporting multi-prefix: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [Swirc](https://www.nifty-networks.net/swirc/), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [IRC for Android](https://play.google.com/store/apps/details?id=com.countercultured.irc4android), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [Biboumi](https://biboumi.codeberg.page/), [BitlBee](https://bitlbee.org/), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
