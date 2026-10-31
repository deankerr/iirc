> Source: https://ircv3.net/specs/extensions/bot-mode Captured: 2026-10-26

# Bot Mode

Copyright © 2021 Daniel Oaks \<daniel@danieloaks.net>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This specification defines a standardised mechanism to allow clients to mark themselves as bots.

<a id="motivation"></a>

## Motivation [🔗](#motivation)

This functionality was previously implemented by several IRC servers in independent ways using fixed mode letters and conflicting WHOIS numerics. This specification seeks to standardise the functionality, adding a message tag for increased visibility of bot status and an ISUPPORT token to allow for more flexible implementations.

<a id="the-bot-isupport-token"></a>

## The `BOT` ISUPPORT token [🔗](#the-bot-isupport-token)

Servers publishing the `BOT` [ISUPPORT](../../../modern/client-protocol.md#feature-advertisement) token let clients mark themselves as bots by setting a user mode. The value of the `BOT` token is the mode character which is used to enable bot mode and is also the flag used in `WHO` responses of bots (e.g. `BOT=B` or `BOT=b`).

When a client is marked as a bot, they are given a special numeric as part of their `WHOIS` response, it is indicated in their `WHO` flags, and servers may include the `bot` tag on that client’s outgoing messages.

<a id="the-rpl_whoisbot-335-numeric"></a>

## The `RPL_WHOISBOT` `(335)` numeric [🔗](#the-rpl_whoisbot-335-numeric)

```
:<server> 335 <nick> <target> :<message>
```

This numeric is returned as part of a bot’s `WHOIS` reply.

Like other WHOIS reply numerics, `<nick>` is the nick of the sender, `<target>` the nick of the client being whoised (the bot), and `<message>` is arbitrary human-readable text.

<a id="the-who-bot-flag"></a>

## The `WHO` bot flag [🔗](#the-who-bot-flag)

When a `RPL_WHOREPLY` `(352)` numeric is returned for a bot, the character used as the value of the ISUPPORT `BOT` token is returned in the flags (alongside `H|G`).

<a id="the-bot-tag"></a>

## The `bot` tag [🔗](#the-bot-tag)

The `bot` tag indicates that the given user is a bot. This tag SHOULD be added by the server to all commands sent by a bot (e.g. `PRIVMSG`, `JOIN`, `MODE`, `NOTICE`, and all others). The tag SHOULD also be added by the ircd to all numerics directly caused by the bot. This tag MUST only be sent to users who have requested the `message-tags` capability. Servers MUST NOT send this tag with a value, and clients MUST ignore any value if it exists.

<a id="examples"></a>

## Examples [🔗](#examples)

The conventional `BOT` ISUPPORT value is `"B"`, but this example uses `"b"` to demonstrate where the value’s used:

```
Bot:    NICK robodan
Bot:    USER u * * :Hi, I'm a bot!
Server: :irc.ircv3.net 001 robodan :Welcome to the IRCv3 IRC Network robodan
Server: [ ... ]
Server: :irc.ircv3.net 005 robodan BOT=b CASEMAPPING=ascii CHANNELLEN=64 CHANTYPES=# ELIST=U EXCEPTS EXTBAN=,m :are supported by this server
Server: [ ... ]
Bot:    MODE robodan +b
Server: :robodan!~u@203.0.113.22 MODE robodan +b
Bot:    WHOIS robodan
Server: :irc.ircv3.net 311 robodan robodan ~u 203.0.113.22 * :Hi, I'm a bot!
Server: :irc.ircv3.net 338 robodan robodan ~u@203.0.113.22 203.0.113.22 :Actual user@host, Actual IP
Server: :irc.ircv3.net 379 robodan robodan :is using modes +bi
Server: :irc.ircv3.net 335 robodan robodan :is a Bot on IRCv3
Server: :irc.ircv3.net 317 robodan robodan 24 1614290357 :seconds idle, signon time
Server: :irc.ircv3.net 318 robodan robodan :End of /WHOIS list
Bot:    WHO robodan
Server: :irc.ircv3.net 352 robodan * ~u 203.0.113.22 irc.ircv3.net robodan Hb :0 Hi, I'm a bot!
Server: :irc.ircv3.net 315 robodan robodan!*@* :End of WHO list


Alice:  whois robodan
Server: :irc.ircv3.net 311 alice robodan ~u 203.0.113.22 * :Hi, I'm a bot!
Server: :irc.ircv3.net 319 alice robodan :#chat
Server: :irc.ircv3.net 335 alice robodan :is a Bot on IRCv3
Server: :irc.ircv3.net 317 alice robodan 258 1614290467 :seconds idle, signon time
Server: :irc.ircv3.net 318 alice robodan :End of /WHOIS list
Alice:  who #chat
Server: :irc.ircv3.net 352 alice #chat ~u 198.51.100.103 irc.ircv3.net alice H :0 I'm a human!
Server: :irc.ircv3.net 352 alice #chat ~u 203.0.113.22 irc.ircv3.net robodan Hb :0 Hi, I'm a bot!
Server: :irc.ircv3.net 315 alice #chat :End of WHO list
[ ... ]
Server: @bot :robodan!~u@203.0.113.22 PRIVMSG #chat :Hello! Try typing .help to see my commands!
```

Example of some future value being sent, which the receiving client will ignore and process as a bare `@bot` tag:

```
Server: @bot=someFutureValueHere=2343 :robodan!~u@203.0.113.22 PRIVMSG #chat :Hello! Try typing .help to see my commands!
```

---

Software supporting Bot Mode: [Ergo](https://ergo.chat/), [InspIRCd](https://www.inspircd.org), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [WeeChat](https://weechat.org), [IRCCloud](https://www.irccloud.com), [Tubes](https://tubes.pronounmail.com), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma), [soju (as Client)](https://codeberg.org/emersion/soju), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [j2i](https://telepath.im/projects/j2i/)
