> Source: https://ircv3.net/specs/extensions/server-time Captured: 2026-10-26

# `server-time` Extension

Copyright © 2012 Stéphan Kochen \<stephan@kochen.nl>

Copyright © 2012 Alexey Sokolov \<alexey-irc@asokolov.org>

Copyright © 2012 Kyle Fuller \<inbox@kylefuller.co.uk>

Copyright © 2016 James Wheare \<james@irccloud.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

Clients indicate support for the extension by requesting a capability server-time as per the [IRC Client Capabilities Extension](https://ircv3.net/specs/core/capability-negotiation).

```
CAP REQ :server-time
```

When enabled, the server-time extension enables optional `time` [message tag](message-tags.md) which can be used in messages from server to client. The value of the tag MUST have the following syntax:

```
<value> ::= YYYY-MM-DDThh:mm:ss.sssZ
```

It represents a calendar date and time of day in UTC using extended format, as specified by ISO 8601:2004(E) 4.3.2. Precision of the time is one millisecond.

If the `time` is presented in a message received from a server, a client SHOULD treat the message as having occurred at the given time instead of its current time.

Servers MAY include the timestamp in messages when they see fit but MUST NOT do so before acknowledging the client capability using `CAP ACK`. Clients MAY choose to simplify parsing by accepting timestamps at any point in the connection (e.g. even before `CAP REQ`).

Servers offering this capability for all messages SHOULD also offer the `echo-message` capability to allow clients to keep a consistent chronology of events.

<a id="examples"></a>

## Examples [🔗](#examples)

This section is non-normative

Angel messaged Wiz at Wed, 19 Oct 2011 16:40:51.620 UTC

```
@time=2011-10-19T16:40:51.620Z :Angel!angel@example.org PRIVMSG Wiz :Hello
```

John joined #chan during the leap second of June 2012 (notice the :60)

```
@time=2012-06-30T23:59:60.419Z :John!~john@1.2.3.4 JOIN #chan
```

<a id="errata"></a>

## Errata [🔗](#errata)

Previous versions of the specification didn’t recommend `echo-message`

---

Software supporting server-time: [Codename IRCat](https://ircat.xyz), [Ergo](https://ergo.chat/), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [Planio Team Chat](https://plan.io/business-chat/), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [Circe](https://github.com/emacs-circe/circe), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [Srain](https://srain.silverrainz.me), [Swirc](https://www.nifty-networks.net/swirc/), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [BitlBee](https://bitlbee.org/), [Matrix2051](https://github.com/progval/matrix2051)
