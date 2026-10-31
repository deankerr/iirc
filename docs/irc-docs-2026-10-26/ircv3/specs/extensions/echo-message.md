> Source: https://ircv3.net/specs/extensions/echo-message Captured: 2026-10-26

# `echo-message` Extension

Copyright © 2014 Attila Molnar \<attilamolnar@hush.com>

Copyright © 2014 J-P Nurmi \<jpnurmi@gmail.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

This client capability MUST be named `echo-message`.

If enabled, servers MUST send `PRIVMSG` and `NOTICE` messages back to the client that sent them. If servers apply any modifications to these messages, they MUST send the final version of the message back to the originating client.

For clients, receiving a message with themselves as the sender acts as an acknowledgement that the message has been delivered to the server. Clients that receive self-sent `PRIVMSG` and `NOTICE` messages, MUST treat them the same way as if the client itself would have sent the message to the target. Clients may choose to disable local echoing of sent `PRIVMSG` and `NOTICE` messages altogether, or present them in pending state.

When the [`message-tags`](message-tags.md) capability has been enabled, the same rules apply to `TAGMSG` messages.

<a id="use-cases"></a>

## Use cases [🔗](#use-cases)

The capability is useful for clients to get an acknowledgement that a message was delivered. It can be also used for measuring lag between client and server, that is, the time it takes from sending a message to receiving it back.

Furthermore, the capability is useful for users that have multiple clients attached to a bouncer. In this scenario, when users send messages from one client, the messages get automatically relayed to other attached clients. This allows all attached clients to display full conversation.

Servers MAY send a faked message back to the client instead, in cases where the final version is silently blocked, for example when filtering spam.

<a id="limitations"></a>

## Limitations [🔗](#limitations)

To prevent perceived input lag, clients may choose not to wait for an acknowledgment from the server before displaying sent messages to users. Clients may instead choose to display a temporary local message that is replaced once the `echo-message` acknowledgment is received. However, correlating these is not straightforward, as the server may modify them before acknowledgment. There are also additional complications for self-targeted private messages.

The [`labeled-response`](labeled-response.md) specification addresses this limitation.

<a id="examples"></a>

## Examples [🔗](#examples)

In the following examples, `example!ex@example.com` presents a client that has enabled the `echo-message` capability.

```
--> PRIVMSG Attila :hi
:example!ex@example.com PRIVMSG Attila :hi
```

The client interprets the received message as if it had sent a `PRIVMSG` with contents “hi” to `Attila`.

Another example where a server modifies a message by filtering out text formatting and sends the final version back:

```
--> PRIVMSG #ircv3 :back from \02lunch\0F
:example!ex@example.com PRIVMSG #ircv3 :back from lunch
```

<a id="errata"></a>

## Errata [🔗](#errata)

Previous versions of this specification didn’t include the Limitations section.

Previous versions of this specification didn’t allow for faked messages when filtering spam.

---

Software supporting echo-message: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [senpai](https://git.sr.ht/~delthas/senpai), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [j2i](https://telepath.im/projects/j2i/), [Matrix2051](https://github.com/progval/matrix2051)
