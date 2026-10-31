> Source: https://ircv3.net/docs/sasl-mechs Captured: 2026-10-26

IRC SASL authentication primarily uses the same mechanisms as SASL in other protocols. Most commonly:

- [PLAIN](https://tools.ietf.org/html/rfc4616) as defined by RFC 4616
- [OAUTHBEARER](https://tools.ietf.org/html/rfc7628) as defined by RFC 7628
- [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A) as defined by RFC 4422
- [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677) as defined by RFC 7677

<a id="desktop-clients"></a>

### Desktop Clients [🔗](#desktop-clients)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [AdiIRC](https://www.adiirc.com) | Yes AdiIRC EXTERNAL | Yes AdiIRC PLAIN | 3.4+ AdiIRC SCRAM-SHA-256 | No AdiIRC OAUTHBEARER |
| [bIRC](https://birc.app) | Yes bIRC EXTERNAL | Yes bIRC PLAIN | Yes bIRC SCRAM-SHA-256 | Yes bIRC OAUTHBEARER |
| [BitchX](https://github.com/BitchX/BitchX1.3) | No BitchX EXTERNAL | Yes BitchX PLAIN | No BitchX SCRAM-SHA-256 | No BitchX OAUTHBEARER |
| [catgirl](https://git.causal.agency/catgirl/about/) | Yes catgirl EXTERNAL | Yes catgirl PLAIN | No catgirl SCRAM-SHA-256 | No catgirl OAUTHBEARER |
| [Circe](https://github.com/emacs-circe/circe) | Yes Circe EXTERNAL | Yes Circe PLAIN | No Circe SCRAM-SHA-256 | No Circe OAUTHBEARER |
| [glirc](https://hackage.haskell.org/package/glirc) | Yes glirc EXTERNAL | Yes glirc PLAIN | Yes glirc SCRAM-SHA-256 | No glirc OAUTHBEARER |
| [Halloy](https://halloy.chat) | Yes Halloy EXTERNAL | Yes Halloy PLAIN | No Halloy SCRAM-SHA-256 | No Halloy OAUTHBEARER |
| [IRCafe](https://github.com/wodencafe/ircafe) | Yes IRCafe EXTERNAL | Yes IRCafe PLAIN | Yes IRCafe SCRAM-SHA-256 | No IRCafe OAUTHBEARER |
| [Irssi](https://irssi.org) | Yes Irssi EXTERNAL | Yes Irssi PLAIN | No Irssi SCRAM-SHA-256 | No Irssi OAUTHBEARER |
| [Konversation](https://konversation.kde.org) | Yes Konversation EXTERNAL | Yes Konversation PLAIN | No Konversation SCRAM-SHA-256 | No Konversation OAUTHBEARER |
| [KVIrc](https://www.kvirc.net) | Yes KVIrc EXTERNAL | Yes KVIrc PLAIN | No KVIrc SCRAM-SHA-256 | No KVIrc OAUTHBEARER |
| [Mango](https://mangoirc.chat) | No Mango EXTERNAL | Yes Mango PLAIN | No Mango SCRAM-SHA-256 | No Mango OAUTHBEARER |
| [mIRC](https://www.mirc.com) | Yes mIRC EXTERNAL | Yes mIRC PLAIN | Yes mIRC SCRAM-SHA-256 | No mIRC OAUTHBEARER |
| [Mozilla Thunderbird](https://www.thunderbird.net/) | No Mozilla Thunderbird EXTERNAL | Yes Mozilla Thunderbird PLAIN | No Mozilla Thunderbird SCRAM-SHA-256 | No Mozilla Thunderbird OAUTHBEARER |
| [Pidgin](https://pidgin.im/) | No Pidgin EXTERNAL | Yes Pidgin PLAIN | Yes Pidgin SCRAM-SHA-256 | No Pidgin OAUTHBEARER |
| [Quassel](https://www.quassel-irc.org) | Yes Quassel EXTERNAL | Yes Quassel PLAIN | No Quassel SCRAM-SHA-256 | No Quassel OAUTHBEARER |
| [senpai](https://git.sr.ht/~delthas/senpai) | No senpai EXTERNAL | Yes senpai PLAIN | No senpai SCRAM-SHA-256 | No senpai OAUTHBEARER |
| [Srain](https://srain.silverrainz.me) | Yes Srain EXTERNAL | Yes Srain PLAIN | No Srain SCRAM-SHA-256 | No Srain OAUTHBEARER |
| [Swirc](https://www.nifty-networks.net/swirc/) | Yes Swirc EXTERNAL | Yes Swirc PLAIN | Yes Swirc SCRAM-SHA-256 | No Swirc OAUTHBEARER |
| [Textual](https://www.codeux.com/textual) | Textual EXTERNAL Yes | Textual PLAIN Yes | Textual SCRAM-SHA-256 No | Textual OAUTHBEARER No |
| [WeeChat](https://weechat.org) | WeeChat EXTERNAL Yes | WeeChat PLAIN Yes | WeeChat SCRAM-SHA-256 Yes | WeeChat OAUTHBEARER No |
| [xC](https://git.janouch.name/p/xK) | xC EXTERNAL Yes | xC PLAIN No | xC SCRAM-SHA-256 No | xC OAUTHBEARER No |
| [ZoiteChat](https://zoitechat.org) | ZoiteChat EXTERNAL Yes | ZoiteChat PLAIN Yes | ZoiteChat SCRAM-SHA-256 Yes | ZoiteChat OAUTHBEARER No |

<a id="web-clients"></a>

### Web Clients [🔗](#web-clients)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [gamja](https://codeberg.org/emersion/gamja) | No gamja EXTERNAL | Yes gamja PLAIN | No gamja SCRAM-SHA-256 | Yes gamja OAUTHBEARER |
| [IRCCloud](https://www.irccloud.com) | No IRCCloud EXTERNAL | Yes IRCCloud PLAIN | Yes IRCCloud SCRAM-SHA-256 | No IRCCloud OAUTHBEARER |
| [jWebIRC](https://github.com/WarPigs1602/jwebirc) | No jWebIRC EXTERNAL | Yes jWebIRC PLAIN | Yes jWebIRC SCRAM-SHA-256 | No jWebIRC OAUTHBEARER |
| [Kiwi IRC](https://kiwiirc.com) | No Kiwi IRC EXTERNAL | Yes Kiwi IRC PLAIN | No Kiwi IRC SCRAM-SHA-256 | No Kiwi IRC OAUTHBEARER |
| [Obby](https://github.com/obbyworld/obby) | Obby EXTERNAL Yes | Obby PLAIN Yes | Obby SCRAM-SHA-256 Yes | Obby OAUTHBEARER Yes |
| [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway) | PIRC.pl web client EXTERNAL No | PIRC.pl web client PLAIN Yes | PIRC.pl web client SCRAM-SHA-256 No | PIRC.pl web client OAUTHBEARER No |
| [The Lounge](https://thelounge.chat/) | The Lounge EXTERNAL Yes | The Lounge PLAIN Yes | The Lounge SCRAM-SHA-256 No | The Lounge OAUTHBEARER No |
| [Tubes](https://tubes.pronounmail.com) | Tubes EXTERNAL No | Tubes PLAIN Yes | Tubes SCRAM-SHA-256 No | Tubes OAUTHBEARER No |

<a id="mobile-clients"></a>

### Mobile Clients [🔗](#mobile-clients)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc) | Yes CoreIRC EXTERNAL | Yes CoreIRC PLAIN | Yes CoreIRC SCRAM-SHA-256 | No CoreIRC OAUTHBEARER |
| [Goguma](https://codeberg.org/emersion/goguma) | No Goguma EXTERNAL | Yes Goguma PLAIN | No Goguma SCRAM-SHA-256 | No Goguma OAUTHBEARER |
| [IRC for Android](https://play.google.com/store/apps/details?id=com.countercultured.irc4android) | No IRC for Android EXTERNAL | No IRC for Android PLAIN | No IRC for Android SCRAM-SHA-256 | No IRC for Android OAUTHBEARER |
| [IRCCloud](https://www.irccloud.com) | IRCCloud EXTERNAL No | IRCCloud PLAIN Yes | IRCCloud SCRAM-SHA-256 Yes | IRCCloud OAUTHBEARER No |
| [Mango](https://mangoirc.chat) | Mango EXTERNAL No | Mango PLAIN Yes | Mango SCRAM-SHA-256 No | Mango OAUTHBEARER No |
| [Palaver](https://palaverapp.com/) | Palaver EXTERNAL No | Palaver PLAIN Yes | Palaver SCRAM-SHA-256 No | Palaver OAUTHBEARER No |
| [Quasseldroid](https://quasseldroid.info/) | Quasseldroid EXTERNAL No | Quasseldroid PLAIN Yes | Quasseldroid SCRAM-SHA-256 No | Quasseldroid OAUTHBEARER No |

<a id="bouncers"></a>

### Bouncers [🔗](#bouncers)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/) | No IRCCloud (as Server) EXTERNAL | No IRCCloud (as Server) PLAIN | No IRCCloud (as Server) SCRAM-SHA-256 | No IRCCloud (as Server) OAUTHBEARER |
| [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc) | No KiwiBNC (as Client) EXTERNAL | No KiwiBNC (as Client) PLAIN | No KiwiBNC (as Client) SCRAM-SHA-256 | No KiwiBNC (as Client) OAUTHBEARER |
| [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc) | No KiwiBNC (as Server) EXTERNAL | No KiwiBNC (as Server) PLAIN | No KiwiBNC (as Server) SCRAM-SHA-256 | No KiwiBNC (as Server) OAUTHBEARER |
| [pounce (as Client)](https://git.causal.agency/pounce/about/) | Yes pounce (as Client) EXTERNAL | Yes pounce (as Client) PLAIN | No pounce (as Client) SCRAM-SHA-256 | No pounce (as Client) OAUTHBEARER |
| [pounce (as Server)](https://git.causal.agency/pounce/about/) | Yes pounce (as Server) EXTERNAL | No pounce (as Server) PLAIN | No pounce (as Server) SCRAM-SHA-256 | No pounce (as Server) OAUTHBEARER |
| [soju (as Client)](https://codeberg.org/emersion/soju) | soju (as Client) EXTERNAL Yes | soju (as Client) PLAIN Yes | soju (as Client) SCRAM-SHA-256 No | soju (as Client) OAUTHBEARER No |
| [soju (as Server)](https://codeberg.org/emersion/soju) | soju (as Server) EXTERNAL No | soju (as Server) PLAIN Yes | soju (as Server) SCRAM-SHA-256 No | soju (as Server) OAUTHBEARER No |
| [ZNC (as Client)](https://znc.in/) | ZNC (as Client) EXTERNAL Yes | ZNC (as Client) PLAIN Yes | ZNC (as Client) SCRAM-SHA-256 No | ZNC (as Client) OAUTHBEARER No |
| [ZNC (as Server)](https://znc.in/) | ZNC (as Server) EXTERNAL 1.10.0+ | ZNC (as Server) PLAIN 1.10.0+ | ZNC (as Server) SCRAM-SHA-256 No | ZNC (as Server) OAUTHBEARER No |

<a id="bots"></a>

### Bots [🔗](#bots)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [BitBot](https://github.com/jesopo/bitbot) | Yes BitBot EXTERNAL | Yes BitBot PLAIN | Yes BitBot SCRAM-SHA-256 | No BitBot OAUTHBEARER |
| [Eggdrop](https://github.com/eggheads/eggdrop) | Yes Eggdrop EXTERNAL | Yes Eggdrop PLAIN | No Eggdrop SCRAM-SHA-256 | No Eggdrop OAUTHBEARER |
| [Limnoria](https://github.com/progval/Limnoria) | Limnoria EXTERNAL Yes | Limnoria PLAIN Yes | Limnoria SCRAM-SHA-256 Yes | Limnoria OAUTHBEARER No |
| [Sopel (ex Willie)](https://sopel.chat) | Sopel (ex Willie) EXTERNAL 8.0.0+ | Sopel (ex Willie) PLAIN 4.1.0+ | Sopel (ex Willie) SCRAM-SHA-256 No | Sopel (ex Willie) OAUTHBEARER No |

<a id="libraries"></a>

### Libraries [🔗](#libraries)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [ChatSharp](https://git.sr.ht/~sircmpwn/ChatSharp) C# | No ChatSharp EXTERNAL | No ChatSharp PLAIN | No ChatSharp SCRAM-SHA-256 | No ChatSharp OAUTHBEARER |
| [Communi](https://communi.github.io) C++ | No Communi EXTERNAL | Yes Communi PLAIN | No Communi SCRAM-SHA-256 | No Communi OAUTHBEARER |
| [girc](https://github.com/lrstanley/girc) Go | Yes girc EXTERNAL | Yes girc PLAIN | No girc SCRAM-SHA-256 | No girc OAUTHBEARER |
| [irc-framework](https://github.com/kiwiirc/irc-framework) JS | No irc-framework EXTERNAL | Yes irc-framework PLAIN | No irc-framework SCRAM-SHA-256 | No irc-framework OAUTHBEARER |
| [ircrobots](https://github.com/jesopo/ircrobots/) Python | No ircrobots EXTERNAL | Yes ircrobots PLAIN | Yes ircrobots SCRAM-SHA-256 | No ircrobots OAUTHBEARER |
| [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib) Java | Yes Kitteh IRC Client Library EXTERNAL | Yes Kitteh IRC Client Library PLAIN | No Kitteh IRC Client Library SCRAM-SHA-256 | No Kitteh IRC Client Library OAUTHBEARER |
| [Net::Async::IRC](https://metacpan.org/pod/Net::Async::IRC) Perl | No Net::Async::IRC EXTERNAL | No Net::Async::IRC PLAIN | No Net::Async::IRC SCRAM-SHA-256 | No Net::Async::IRC OAUTHBEARER |
| [pydle](https://pypi.python.org/pypi/pydle) Python | pydle EXTERNAL No | pydle PLAIN Yes | pydle SCRAM-SHA-256 No | pydle OAUTHBEARER No |
| [Rust irc](https://github.com/aatxe/irc) Rust | Rust irc EXTERNAL No | Rust irc PLAIN Yes | Rust irc SCRAM-SHA-256 No | Rust irc OAUTHBEARER No |
| [Warren](https://github.com/WillowChat/Warren) Kotlin | Warren EXTERNAL No | Warren PLAIN Yes | Warren SCRAM-SHA-256 No | Warren OAUTHBEARER No |
| [zIRC](https://github.com/itslukej/zirc) Python | zIRC EXTERNAL Yes | zIRC PLAIN Yes | zIRC SCRAM-SHA-256 No | zIRC OAUTHBEARER No |

<a id="services-packages"></a>

### Services Packages [🔗](#services-packages)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [Anope](https://anope.org) | Yes Anope EXTERNAL | Yes Anope PLAIN | No Anope SCRAM-SHA-256 | No Anope OAUTHBEARER |
| [Atheme](https://atheme.github.io/) | Yes Atheme EXTERNAL | Yes Atheme PLAIN | 7.3+ Atheme SCRAM-SHA-256 | No Atheme OAUTHBEARER |
| [Dalek](https://github.com/DalekIRC/Dalek-Services) | Dalek EXTERNAL Yes | Dalek PLAIN Yes | Dalek SCRAM-SHA-256 No | Dalek OAUTHBEARER No |
| [X3](https://github.com/evilnet/x3) | X3 EXTERNAL Yes | X3 PLAIN Yes | X3 SCRAM-SHA-256 No | X3 OAUTHBEARER No |

<a id="bridges"></a>

### Bridges [🔗](#bridges)

|  | [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A "EXTERNAL SASL mechanism") | [PLAIN](https://tools.ietf.org/html/rfc4616 "PLAIN SASL mechanism") | [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677 "SASL SCRAM-SHA-256 mechanism") | [OAUTHBEARER](https://tools.ietf.org/html/rfc7628 "OAUTHBEARER SASL mechanism") |
| --- | --- | --- | --- | --- |
| [Biboumi](https://biboumi.codeberg.page/) | No Biboumi EXTERNAL | 9.0+ Biboumi PLAIN | No Biboumi SCRAM-SHA-256 | No Biboumi OAUTHBEARER |
| [BitlBee](https://bitlbee.org/) | No BitlBee EXTERNAL | No BitlBee PLAIN | No BitlBee SCRAM-SHA-256 | No BitlBee OAUTHBEARER |
| [Heisenbridge (bouncer mode)](https://github.com/hifi/heisenbridge) | Yes Heisenbridge (bouncer mode) EXTERNAL | Yes Heisenbridge (bouncer mode) PLAIN | No Heisenbridge (bouncer mode) SCRAM-SHA-256 | No Heisenbridge (bouncer mode) OAUTHBEARER |
| [j2i](https://telepath.im/projects/j2i/) | No j2i EXTERNAL | Yes j2i PLAIN | No j2i SCRAM-SHA-256 | No j2i OAUTHBEARER |
| [matrix-appservice-irc](https://github.com/matrix-org/matrix-appservice-irc/) | matrix-appservice-irc EXTERNAL No | matrix-appservice-irc PLAIN Yes | matrix-appservice-irc SCRAM-SHA-256 No | matrix-appservice-irc OAUTHBEARER No |
| [Matrix2051](https://github.com/progval/matrix2051) | Matrix2051 EXTERNAL No | Matrix2051 PLAIN Yes | Matrix2051 SCRAM-SHA-256 No | Matrix2051 OAUTHBEARER No |
| [Matterbridge](https://github.com/42wim/matterbridge) | Matterbridge EXTERNAL No | Matterbridge PLAIN Yes | Matterbridge SCRAM-SHA-256 No | Matterbridge OAUTHBEARER No |
| [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink) | PyLink (clientbot mode) EXTERNAL Yes | PyLink (clientbot mode) PLAIN Yes | PyLink (clientbot mode) SCRAM-SHA-256 No | PyLink (clientbot mode) OAUTHBEARER No |
