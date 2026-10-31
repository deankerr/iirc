> Source: https://ircv3.net/specs/extensions/sasl-3.2 Captured: 2026-10-26

# IRCv3.2 SASL Authentication

Copyright © 2014 Attila Molnar \<attilamolnar@hush.com>

Copyright © 2015 William Pitcock \<nenolod@dereferenced.org>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

**Updates:** [SASL v3.1](sasl-3.1.md)

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This document describes how [SASL authentication](sasl-3.1.md) makes use of the [capability negotiation protocol updates introduced by CAP Version `302`](https://ircv3.net/specs/core/capability-negotiation), and adds support for reauthentication if authentication is lost via the [cap-notify](https://ircv3.net/specs/core/capability-negotiation) capability.

<a id="advertisement-of-sasl-capability-when-authentication-is-unavailable"></a>

## Advertisement of `sasl` capability when authentication is unavailable [🔗](#advertisement-of-sasl-capability-when-authentication-is-unavailable)

Servers MUST NOT advertise the `sasl` capability if the authentication layer is unavailable.

Servers MUST `NAK` any `sasl` capability request if the authentication layer is unavailable.

If a client requires pre-authentication and is unable to obtain the `sasl` capability, then the client MUST disconnect and MAY retry the connection.

<a id="mechanism-list-in-cap-ls"></a>

## Mechanism list in CAP LS [🔗](#mechanism-list-in-cap-ls)

Servers SHOULD advertise the available SASL authentication mechanisms in the value of the `sasl` client capability in `CAP LS`.

The value, if present, MUST be a comma (`,`) separated list of SASL authentication mechanisms.

Clients MUST handle the case when there is no value for the `sasl` capability in `CAP LS` even though they are attempting to use a version of the capability negotiation protocol that allows values (i.e. 3.2).

Clients MUST handle the case when the value contains one or more mechanisms they do not understand.

<a id="integration-with-cap-notify"></a>

## Integration with `cap-notify` [🔗](#integration-with-cap-notify)

The `sasl` capability is integrated with the new `cap-notify` framework, such that if `cap-notify` is an active capability, the client will be notified about status changes concerning the availability of `sasl` authentication.

Servers MUST advertise availability of the `sasl` capability to any clients which have requested the `cap-notify` notification.

<a id="sasl-reauthentication"></a>

## SASL Reauthentication [🔗](#sasl-reauthentication)

Servers SHOULD allow a client, authenticated or otherwise, to reauthenticate by sending a new `AUTHENTICATE` message at any time. If reauthentication is not available, an error appropriate to the circumstances MUST be sent (for instance, `ERR_SASLALREADY` is appropriate if changing accounts is not supported).

Servers MAY disconnect ANY client at any time as a result of failed authentication, including both unregistered and registered clients, but MUST provide the reason for the authentication failure prior to disconnection.

<a id="usage"></a>

## Usage [🔗](#usage)

Clients SHOULD pick a mechanism present in the `CAP LS` reply they get from the server and attempt to use that mechanism for authentication after they request the `sasl` capability.

Clients MUST handle the case when a mechanism they picked from the list turns out to be not available.

<a id="examples"></a>

## Examples [🔗](#examples)

Example where the server only supports the EXTERNAL mechanism:

```
Client: CAP LS 302
Server: CAP * LS :sasl=EXTERNAL
```

Example where the server supports multiple authentication mechanisms and the client picks its favorite and attempts to use it:

```
Client: CAP LS 302
Client: NICK modernclient
Client: USER modernclient 0 0 :Modern Client
Server: CAP * LS :sasl=EXTERNAL,FOO,DH-AES,BAR,DH-BLOWFISH,FOOBAR,PLAIN batch cap-notify
Client: CAP REQ :sasl
Server: CAP modernclient ACK :sasl
Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +
Client: AUTHENTICATE ...
```

Example where the server later adds support for authentication, such as regaining access to an authentication server after a netsplit:

```
Server: CAP modernclient NEW :sasl=PLAIN
Client: CAP REQ :sasl
Server: CAP modernclient ACK :sasl
Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +
Client: AUTHENTICATE ...
```

Example where the server disconnects a client for excessive reauthentications:

```
Client: CAP REQ :sasl
Server: CAP modernclient ACK :sasl
Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +
Client: AUTHENTICATE ...
Server: :irc.server.tld 904 modernclient :SASL authentication failed
Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +
Client: AUTHENTICATE ...
Server: :irc.server.tld 904 modernclient :SASL authentication failed
Client: AUTHENTICATE PLAIN
Server: AUTHENTICATE +
Client: AUTHENTICATE ...
Server: :irc.server.tld 904 modernclient :SASL authentication failed
Server: ERROR :Too many SASL authentication failures
```

<a id="errata"></a>

## Errata [🔗](#errata)

A previous version of this specification had reauthentication listed as a MUST requirement. This was weakened to SHOULD, to allow servers that cannot implement reauthentication for technical or policy reasons to be compliant.

See [issue #192](https://github.com/ircv3/ircv3-specifications/issues/192) for more information.

---

Software supporting SASL v3.2: [Ergo](https://ergo.chat/), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [IRCafe](https://github.com/wodencafe/ircafe), [Konversation](https://konversation.kde.org), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [Srain](https://srain.silverrainz.me), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [zIRC](https://github.com/itslukej/zirc), [BitlBee](https://bitlbee.org/), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
