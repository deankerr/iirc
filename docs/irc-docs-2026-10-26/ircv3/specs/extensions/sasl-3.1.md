> Source: https://ircv3.net/specs/extensions/sasl-3.1 Captured: 2026-10-26

# IRCv3.1 SASL Authentication

Copyright © 2009-2012 Jilles Tjoelker \<jilles@stack.nl>

Copyright © 2009-2012 William Pitcock \<nenolod@dereferenced.org>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

**Updated by:** [SASL v3.2](sasl-3.2.md)

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This document describes the client protocol for SASL authentication, as implemented in Charybdis and Atheme.

The SASL protocol in general is documented in [RFC 4422](https://tools.ietf.org/html/rfc4422), along with the ‘EXTERNAL’ mechanism. The most commonly used ‘PLAIN’ mechanism is documented in [RFC 4616](https://tools.ietf.org/html/rfc4616).

SASL authentication relies on the [CAP client capability framework](https://ircv3.net/specs/core/capability-negotiation).

Support for SASL authentication is indicated with the “sasl” capability. The client MUST enable the sasl capability before using the AUTHENTICATE command defined by this specification.

<a id="the-authenticate-command"></a>

## The AUTHENTICATE command [🔗](#the-authenticate-command)

The AUTHENTICATE command MUST be used before registration is complete and with the sasl capability enabled. To enforce the former, it is RECOMMENDED to only send CAP END when the SASL exchange is completed or needs to be aborted. Clients SHOULD be prepared for timeouts at all times during the SASL authentication.

There are two forms of the AUTHENTICATE command: initial client message and later messages.

The initial client message specifies the SASL mechanism to be used. (When this is received, the IRCD will attempt to establish an association with a SASL agent.) If this fails, a 904 numeric will be sent and the session state remains unchanged; the client MAY try another mechanism. Otherwise, the server sends a set of regular AUTHENTICATE messages with the initial server response. If the chosen mechanism is client-first, the server sends an empty response (`AUTHENTICATE +`, as described below).

```
AUTHENTICATE <mechanism>
```

A set of regular AUTHENTICATE messages transmits a response from client to server or vice versa. The server MAY intersperse other IRC protocol messages between the AUTHENTICATE messages of a set. The response is encoded in Base64 ([RFC 4648](https://tools.ietf.org/html/rfc4648)), then split to 400-byte chunks, and each chunk is sent as a separate `AUTHENTICATE` command. Empty (zero-length) responses are sent as `AUTHENTICATE +`. If the last chunk was exactly 400 bytes long, it must also be followed by `AUTHENTICATE +` to signal end of response. The server MAY place a limit on the total length of a response.

```
*(AUTHENTICATE <400BASE64>)
AUTHENTICATE <399BASE64 | '+'>
```

If the mechanism finishes with the server sending a non-empty challenge (such as in SCRAM), clients MUST still send an empty response.

The client can abort an authentication by sending an asterisk as the data. The server will send a 906 numeric.

```
AUTHENTICATE '*'
```

If authentication fails, a 904 or 905 numeric will be sent and the client MAY retry from the `AUTHENTICATE <mechanism>` command. If authentication is successful, a 900 and 903 numeric will be sent.

If the client attempts to issue the AUTHENTICATE command after already authenticating successfully, the server MUST reject it with a 907 numeric.

If the client completes registration (with CAP END, NICK, USER and any other necessary messages) while the SASL authentication is still in progress, the server SHOULD abort it and send a 906 numeric, then register the client without authentication.

This document does not specify use of the AUTHENTICATE command in registered (person) state.

<a id="example-protocol-exchange"></a>

## Example protocol exchange [🔗](#example-protocol-exchange)

C: indicates lines sent by the client, S: indicates lines sent by the server.

The client is using the PLAIN SASL mechanism with authentication identity `jilles`, authorization identity `jilles` and password `sesame`.

```
C: CAP REQ :sasl
C: NICK jilles
C: USER jilles cheetah.stack.nl 1 :Jilles Tjoelker
S: NOTICE AUTH :*** Processing connection to jaguar.test
S: NOTICE AUTH :*** Looking up your hostname...
S: NOTICE AUTH :*** Checking Ident
S: NOTICE AUTH :*** No Ident response
S: NOTICE AUTH :*** Found your hostname
S: :jaguar.test CAP jilles ACK :sasl
C: AUTHENTICATE PLAIN
S: AUTHENTICATE +
C: AUTHENTICATE amlsbGVzAGppbGxlcwBzZXNhbWU=
S: :jaguar.test 900 jilles jilles!jilles@localhost.stack.nl jilles :You are now logged in as jilles
S: :jaguar.test 903 jilles :SASL authentication successful
C: CAP END
S: :jaguar.test 001 jilles :Welcome to the jillestest Internet Relay Chat Network jilles
(usual welcome messages)
```

The client is using the SCRAM-SHA-1 mechanism.

```
C: CAP REQ :sasl
C: NICK jilles
C: USER jilles cheetah.stack.nl 1 :Jilles Tjoelker
S: NOTICE AUTH :*** Processing connection to jaguar.test
S: NOTICE AUTH :*** Looking up your hostname...
S: NOTICE AUTH :*** Checking Ident
S: NOTICE AUTH :*** No Ident response
S: NOTICE AUTH :*** Found your hostname
S: :jaguar.test CAP jilles ACK :sasl
C: AUTHENTICATE SCRAM-SHA-1
S: AUTHENTICATE +
C: AUTHENTICATE bixhPWppbGxlcyxuPWppbGxlcyxyPWM1UnFMQ1p5MEw0ZkdrS0FaMGh1akZCcw==
S: AUTHENTICATE cj1jNVJxTENaeTBMNGZHa0tBWjBodWpGQnNYUW9LY2l2cUN3OWlEWlBTcGIscz01bUpPNmQ0cmpDbnNCVTFYLGk9NDA5Ng==
C: AUTHENTICATE Yz1iaXhoUFdwcGJHeGxjeXc9LHI9YzVScUxDWnkwTDRmR2tLQVowaHVqRkJzWFFvS2NpdnFDdzlpRFpQU3BiLHA9T1ZVaGdQdTh3RW0yY0RvVkxmYUh6VlVZUFdVPQ==
S: AUTHENTICATE dj1aV1IyM2M5TUppcjBaZ2ZHZjVqRXRMT242Tmc9
C: AUTHENTICATE +
S: :jaguar.test 900 jilles jilles!jilles@localhost.stack.nl jilles :You are now logged in as jilles
S: :jaguar.test 903 jilles :SASL authentication successful
C: CAP END
S: :jaguar.test 001 jilles :Welcome to the jillestest Internet Relay Chat Network jilles
(usual welcome messages)
```

Servers may also add a source to their AUTHENTICATE messages, just like any message.

```
C: CAP REQ :sasl
C: NICK jilles
C: USER jilles cheetah.stack.nl 1 :Jilles Tjoelker
S: NOTICE AUTH :*** Processing connection to jaguar.test
S: NOTICE AUTH :*** Looking up your hostname...
S: NOTICE AUTH :*** Checking Ident
S: NOTICE AUTH :*** No Ident response
S: NOTICE AUTH :*** Found your hostname
S: :jaguar.test CAP jilles ACK :sasl
C: AUTHENTICATE SCRAM-SHA-1
S: :jaguar2.test AUTHENTICATE +
C: AUTHENTICATE bixhPWppbGxlcyxuPWppbGxlcyxyPWM1UnFMQ1p5MEw0ZkdrS0FaMGh1akZCcw==
S: :jaguar2.test AUTHENTICATE cj1jNVJxTENaeTBMNGZHa0tBWjBodWpGQnNYUW9LY2l2cUN3OWlEWlBTcGIscz01bUpPNmQ0cmpDbnNCVTFYLGk9NDA5Ng==
C: AUTHENTICATE Yz1iaXhoUFdwcGJHeGxjeXc9LHI9YzVScUxDWnkwTDRmR2tLQVowaHVqRkJzWFFvS2NpdnFDdzlpRFpQU3BiLHA9T1ZVaGdQdTh3RW0yY0RvVkxmYUh6VlVZUFdVPQ==
S: :jaguar2.test AUTHENTICATE dj1aV1IyM2M5TUppcjBaZ2ZHZjVqRXRMT242Tmc9
C: AUTHENTICATE +
S: :jaguar.test 900 jilles jilles!jilles@localhost.stack.nl jilles :You are now logged in as jilles
S: :jaguar.test 903 jilles :SASL authentication successful
C: CAP END
S: :jaguar.test 001 jilles :Welcome to the jillestest Internet Relay Chat Network jilles
(usual welcome messages)
```

Alternatively the client could request the list of capabilities and enable an additional capability.

```
C: CAP LS
C: NICK jilles
C: USER jilles cheetah.stack.nl 1 :Jilles Tjoelker
S: NOTICE AUTH :*** Processing connection to jaguar.test
S: NOTICE AUTH :*** Looking up your hostname...
S: NOTICE AUTH :*** Checking Ident
S: NOTICE AUTH :*** No Ident response
S: NOTICE AUTH :*** Found your hostname
S: :jaguar.test CAP * LS :multi-prefix sasl
C: CAP REQ :multi-prefix sasl
S: :jaguar.test CAP jilles ACK :multi-prefix sasl
C: AUTHENTICATE PLAIN
S: AUTHENTICATE +
C: AUTHENTICATE amlsbGVzAGppbGxlcwBzZXNhbWU=
S: :jaguar.test 900 jilles jilles!jilles@localhost.stack.nl jilles :You are now logged in as jilles
S: :jaguar.test 903 jilles :SASL authentication successful
C: CAP END
S: :jaguar.test 001 jilles :Welcome to the jillestest Internet Relay Chat Network jilles
(usual welcome messages)
```

The client is using a long password and splits its response into two chunks.

```
C: AUTHENTICATE PLAIN
S: AUTHENTICATE +
C: AUTHENTICATE AGVtZXJzaW9uAEVzdCB1dCBiZWF0YWUgb21uaXMgaXBzYW0uIFF1aXMgZnVnaWF0IGRlbGVuaXRpIHRvdGFtIHF1aS4gSXBzdW0gcXVhbSBhIGRvbG9ydW0gdGVtcG9yYSB2ZWxpdCBsYWJvcnVtIG9kaXQuIEV0IHNhZXBlIHZvbHVwdGF0ZSBzZWQgY3VtcXVlIHZlbC4gVm9sdXB0YXMgc2ludCBhYiBwYXJpYXR1ciBsaWJlcm8gdmVyaXRhdGlzIGNvcnJ1cHRpLiBWZXJvIGl1cmUgb21uaXMgdWxsYW0uIFZlcm8gYmVhdGFlIGRvbG9yZXMgZmFjZXJlIGZ1Z2lhdCBpcHNhbS4gRWEgZXN0IHBhcmlhdHVyIG1pbmltYSBub2JpcyBz
C: AUTHENTICATE dW50IGF1dCB1dC4gRG9sb3JlcyB1dCBsYXVkYW50aXVtIG1haW9yZXMgdGVtcG9yaWJ1cyB2b2x1cHRhdGVzLiBSZWljaWVuZGlzIGltcGVkaXQgb21uaXMgZXQgdW5kZSBkZWxlY3R1cyBxdWFzIGFiLiBRdWFlIGVsaWdlbmRpIG5lY2Vzc2l0YXRpYnVzIGRvbG9yaWJ1cyBtb2xlc3RpYXMgdGVtcG9yYSBtYWduYW0gYXNzdW1lbmRhLg==
S: :irc.example.org 900 emersion emersion!emersion@emersion.fr emersion :You are now logged in as emersion
S: :irc.example.org 903 emersion :SASL authentication successful
```

<a id="numerics-used-by-this-extension"></a>

## Numerics used by this extension [🔗](#numerics-used-by-this-extension)

`900` aka `RPL_LOGGEDIN` is sent when the user’s account name is set (whether by SASL or otherwise).

```
:server 900 <nick> <nick>!<ident>@<host> <account> :You are now logged in as <user>
```

`901` aka `RPL_LOGGEDOUT` is sent when the user’s account name is unset (whether by SASL or otherwise).

```
:server 901 <nick> <nick>!<ident>@<host> :You are now logged out
```

`902` aka `ERR_NICKLOCKED` is sent when the SASL authentication fails because the account is currently locked out, held, or otherwise administratively made unavailable.

```
:server 902 <nick> :You must use a nick assigned to you
```

`903` aka `RPL_SASLSUCCESS` is sent when the SASL authentication finishes successfully. It usually goes along with `900`.

```
:server 903 <nick> :SASL authentication successful
```

`904` aka `ERR_SASLFAIL` is sent when the SASL authentication fails because of invalid credentials or other errors not explicitly mentioned by other numerics.

```
:server 904 <nick> :SASL authentication failed
```

`905` aka `ERR_SASLTOOLONG` is sent when credentials are valid, but the SASL authentication fails because the client-sent `AUTHENTICATE` command was too long (i.e. the parameter longer than 400 bytes).

```
:server 905 <nick> :SASL message too long
```

`906` aka `ERR_SASLABORTED` is sent when the SASL authentication is aborted because the client sent an `AUTHENTICATE` command with `*` as the parameter.

```
:server 906 <nick> :SASL authentication aborted
```

`907` aka `ERR_SASLALREADY` is sent when the client attempts to initiate SASL authentication after it has already finished successfully for that connection.

```
:server 907 <nick> :You have already authenticated using SASL
```

`908` aka `RPL_SASLMECHS` MAY be sent in reply to an `AUTHENTICATE` command which requests an unsupported mechanism. The numeric contains a comma-separated list of mechanisms supported by the server (or network, services).

```
:server 908 <nick> <mechanisms> :are available SASL mechanisms
```

_(The final “text” parameter is not to be machine-parsed, as it tends to vary between implementations and translations.)_

<a id="errata"></a>

# Errata [🔗](#errata)

- Previous versions of this specification mentioned that 904 numeric would be used when SASL was aborted. 906 ERR\_SASLABORTED should be used when SASL is aborted.
- Previous versions of this specification did not precisely describe when is RPL\_SASLMECHS being sent.
- Clarified the language how responses are transmitted.
- Added empty initial server response for client-first mechanisms. This had happened de-facto already.
- Added empty final client response for certain mechanisms. This had happened de-facto already.
- Previous versions of this specification precisely specified the serialization, de-jure making it stricter than regular IRC command (disallowing colons). It now uses a higher-level grammar similar to other IRCv3 specifications, which assumes messages are parsed using RFC1459-like deserialisation, as this is how it is was already implemented and understood in practice.

---

Software supporting SASL v3.1: [Ergo](https://ergo.chat/), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Planio Team Chat](https://plan.io/business-chat/), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [BitchX](https://github.com/BitchX/BitchX1.3), [catgirl](https://git.causal.agency/catgirl/about/), [Circe](https://github.com/emacs-circe/circe), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [Pidgin](https://pidgin.im/), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [Srain](https://srain.silverrainz.me), [Swirc](https://www.nifty-networks.net/swirc/), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [xC](https://git.janouch.name/p/xK), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [IRC for Android](https://play.google.com/store/apps/details?id=com.countercultured.irc4android), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [Quasseldroid](https://quasseldroid.info/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren), [zIRC](https://github.com/itslukej/zirc), [Biboumi](https://biboumi.codeberg.page/), [BitlBee](https://bitlbee.org/), [Heisenbridge (bouncer mode)](https://github.com/hifi/heisenbridge), [j2i](https://telepath.im/projects/j2i/), [matrix-appservice-irc](https://github.com/matrix-org/matrix-appservice-irc/), [Matrix2051](https://github.com/progval/matrix2051), [Matterbridge](https://github.com/42wim/matterbridge), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
