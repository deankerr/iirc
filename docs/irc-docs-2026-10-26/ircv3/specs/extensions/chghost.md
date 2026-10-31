> Source: https://ircv3.net/specs/extensions/chghost Captured: 2026-10-26

# `chghost` Extension

Copyright © 2013 Christine Dodrill \<me@christine.website>

Copyright © 2016 Ryan \<ryan@hashbang.sh>

Copyright © 2020 James Wheare \<james@irccloud.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

The `chghost` capability allows servers to send a notification when clients change their username or host. This mechanism avoids simulating a reconnect of the client. This is useful for servers that implement virtual hosts or cloaks, and helps to reduce clutter in client UI.

<a id="the-chghost-capability"></a>

## The `chghost` capability [🔗](#the-chghost-capability)

When a client username or host is changed, servers MUST send the `CHGHOST` message to other clients who share channels with the target client and who have enabled the `chghost` capability. Servers SHOULD also send the `CHGHOST` message to the client whose own username or host changed, if that client also supports the `chghost` capability.

<a id="the-chghost-message"></a>

## The `CHGHOST` message [🔗](#the-chghost-message)

The `CHGHOST` message is as follows:

```
:nick!old_user@old_host.local CHGHOST new_user new_host.local
```

The `new_user` parameter represents the user’s username.

The `new_host.local` parameter represents the user’s hostname.

One or both of the username and hostname can change during the CHGHOST process.

Servers that implement ident checking might choose to prefix a username with a tilde `~` character to indicate missing confirmation from an ident server. This MUST be considered part of the username and included in any CHGHOST messages where relevant.

```
:nick!~old_user@old_host.local CHGHOST ~new_user new_host.local
```

<a id="fallback-when-the-chghost-capability-has-not-been-negotiated"></a>

## Fallback when the `chghost` capability has not been negotiated [🔗](#fallback-when-the-chghost-capability-has-not-been-negotiated)

When the capability is not enabled for other clients who share channels with the changed client, servers SHOULD send fallback messages to simulate the client reconnecting. This allows clients to keep their user state up to date. For shared channels, the simulated events SHOULD include appropriate `QUIT`, `JOIN` and `MODE` commands, to restore membership and user channel modes.

```
:nick!old_user@old_host.local QUIT :Changing hostname
:nick!new_user@new_host.local JOIN #ircv3
:ircd.local MODE #ircv3 +v :nick
```

<a id="examples"></a>

## Examples [🔗](#examples)

In this example, `tim!~toolshed@backyard` gets their username changed to `~b` and their hostname changed to `ckyard`. Their new user mask is `tim!~b@ckyard`:

```
:tim!~toolshed@backyard CHGHOST ~b ckyard
```

In this example, `tim!b@ckyard` gets their username changed to `toolshed` and their hostname changed to `backyard`. Their new user mask is `tim!toolshed@backyard`:

```
:tim!b@ckyard CHGHOST toolshed backyard
```

<a id="errata"></a>

## Errata [🔗](#errata)

- Previous versions of this specification did not include any examples, which made it unclear as to whether the de-facto `~` prefix should be included on CHGHOST messages. The new examples make clear that it should be included.
- Previous versions of this specification did not specify whether or not the client whose own user or host changed should receive the message.

---

Software supporting chghost: [Ergo](https://ergo.chat/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [Circe](https://github.com/emacs-circe/circe), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [Swirc](https://www.nifty-networks.net/swirc/), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [Heisenbridge (bouncer mode)](https://github.com/hifi/heisenbridge), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
