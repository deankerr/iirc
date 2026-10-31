> Source: https://ircv3.net/specs/extensions/whox Captured: 2026-10-26

# WHOX

Copyright © 2021 Simon Ser \<contact@emersion.fr>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

The WHOX extension allows clients to request additional fields in the `WHO` response (e.g. account name) or omit default fields (e.g. username and hostname).

<a id="isupport-token"></a>

## `ISUPPORT` token [🔗](#isupport-token)

Servers supporting this specification MUST include the `WHOX` token in `RPL_ISUPPORT` without any value. Clients MUST accept `WHOX` tokens with a value for forwards compatibility.

<a id="extended-who-command"></a>

## Extended `WHO` command [🔗](#extended-who-command)

The `WHO` command is extended with an optional argument:

```
WHO <mask> [%<fields>[,<token>]]
```

The second argument contains a percent character followed by a list of fields requested by the client. Each field is represented by a letter. The standard fields are:

- `t`: return the `<token>` specified by the client
- `c`: return an arbitrary channel the client is joined to
- `u`: return the username
- `i`: return the IP address
- `h`: return the hostname
- `s`: return the server name
- `n`: return the nickname
- `f`: return the `WHO` flags (away, server operator, etc)
- `d`: return the hop count (distance)
- `l`: return the number of seconds the user has been idle for
- `a`: return the account name
- `o`: return the channel op level
- `r`: return the realname

Servers MAY support additional non-standard fields. Servers MUST NOT rely on the ordering of the fields.

Clients can also specify a token which will be returned by the server in the replies. The token MUST contain only digit characters and MUST contain at most 3 characters. Clients MUST NOT include ‘t’ in `<fields>` without specifying a token.

Servers MAY support additional non-standard flags before the percent character.

The server will reply with zero, one or more `RPL_WHOSPCRPL` replies, followed by a final `RPL_ENDOFWHO` reply. Servers MUST NOT send `RPL_WHOREPLY` replies.

<a id="rpl_whospcrpl-354-numeric-reply"></a>

## `RPL_WHOSPCRPL` (354) numeric reply [🔗](#rpl_whospcrpl-354-numeric-reply)

```
:<server> 354 <client> [token] [channel] [user] [ip] [host] [server] [nick] [flags] [hopcount] [idle] [account] [oplevel] [:realname]
```

Servers MUST send the fields in the order specified above. Servers MUST include in their reply all of the standard fields requested by the client, and MUST NOT add any additional field not requested by the client. Servers MUST ignore any non-standard field they don’t support.

Exactly the fields requested by the client MUST be returned by the server. When the server omits a field the client has requested, the following placeholders MUST be used:

- `*` is used for `[channel]` when no channel is returned.
- `255.255.255.255` is used for `[ip]` when the server refuses to disclose the IP address.
- `0` is used for `[account]` when the user is logged out.
- Any syntactically correct placeholder can be used for `[oplevel]` when the server doesn’t support op levels, for instance `n/a`.

Clients SHOULD ignore the values of the hop count (`d`) and the channel op level (`o`) fields, because they are ill-defined and unreliable.

<a id="examples"></a>

## Examples [🔗](#examples)

<a id="without-a-token"></a>

### Without a token [🔗](#without-a-token)

```
WHO cooluser %cuhnar
:irc.example.org 354 mynick #ircv3 ~cooluser coolhost cooluser coolaccount :Cool User
:irc.example.org 315 mynick cooluser :End of WHO list
```

<a id="with-a-token"></a>

### With a token [🔗](#with-a-token)

```
WHO #ircv3 %afnt,42
:irc.example.org 354 mynick #ircv3 42 cooluser H coolaccount
:irc.example.org 354 mynick #ircv3 42 cooloper H* cooloper
:irc.example.org 315 mynick #ircv3 :End of WHO list
```

---

Software supporting WHOX: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [ircu2](https://github.com/UndernetIRC/ircu2), [juno](https://github.com/cooper/juno), [Nefarious IRCu](https://github.com/evilnet/nefarious2), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Konversation](https://konversation.kde.org), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma), [Quasseldroid](https://quasseldroid.info/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [ZNC (as Client)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Sopel (ex Willie)](https://sopel.chat), [PyLink (clientbot mode)](https://code.overdrivenetworks.com/pylink)
