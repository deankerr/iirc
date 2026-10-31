> Source: https://ircv3.net/specs/extensions/account-notify Captured: 2026-10-26

# `account-notify` Extension

Copyright © 2010 William Pitcock \<nenolod@dereferenced.org>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

The account-notify client capability allows a client to be notified when a client’s account name changes. This capability MUST be referred to as ‘account-notify’ at capability negotiation time.

When enabled, clients will get the ACCOUNT message to designate the account name changes for clients on common channels with them, including themselves.

The ACCOUNT message is one of the following:

```
:nick!user@host ACCOUNT accountname
```

This message represents that the user identified by nick!user@host has logged into a new account. The last parameter is the display name of that account.

```
:nick!user@host ACCOUNT *
```

This message represents that the user identified by nick!user@host has logged out of their account. As the last parameter is an asterisk, this means that an asterisk is not a valid account name (which it is not in P10 or TS6 or ESVID).

In order to take full advantage of the ACCOUNT message, WHOX must be supported by the ircd. In this case, the appropriate strategy to ensuring you always have the account name to display is to do the following:

1.  Enable the “account-notify” capability at capability negotiation time during the login handshake.

2.  When joining a channel, query the channel using WHO and ensure that you include the `a` format token in your WHOX token request. When you get a reply, do appropriate caching.

3.  If the extended-join capability is available, enable it at client capability negotiation time during the login handshake, and then set the account name based on what is sent in the extended JOIN command.

```
Otherwise, if extended-join is unavailable: When new users join a channel that your client does not know the account name for yet, do a WHO query against that client, again including the `a` format token in your WHOX token request field. When you get a reply, do appropriate caching.
```

4.  When the client receives an ACCOUNT message, update the account name for the client in question in your account name cache.

<a id="errata"></a>

## Errata [🔗](#errata)

A previous version of this specification advised making a WHO request following a netsplit. This advice was deemed unnecessary and was removed. See [issue #146](https://github.com/ircv3/ircv3-specifications/issues/146) for more information, including rationale for this clarification.

A previous version of this specification didn’t make it clear that account-notify messages are sent for a client’s own account name changes.

---

Software supporting account-notify: [Ergo](https://ergo.chat/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [Swirc](https://www.nifty-networks.net/swirc/), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Quasseldroid](https://quasseldroid.info/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
