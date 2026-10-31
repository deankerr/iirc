> Source: https://ircv3.net/specs/extensions/account-extban Captured: 2026-10-26

# Account Extended Ban

Copyright © 2021-2022 June McEnroe \<june@causal.agency>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

The [account-notify](account-notify.md), [account-tag](account-tag.md) and [extended-join](extended-join.md) specifications allow clients to much more easily know the account names of logged in users. The [EXTBAN](../../../modern/client-protocol.md#extban-parameter) ISUPPORT token indicates the types of extended ban masks that the server supports, but not their meanings. This specification allows clients to construct ban masks for accounts by indicating which extended ban type matches account names.

<a id="the-accountextban-isupport-token"></a>

## The `ACCOUNTEXTBAN` ISUPPORT token [🔗](#the-accountextban-isupport-token)

Servers publishing the `ACCOUNTEXTBAN` [ISUPPORT](../../../modern/client-protocol.md#feature-advertisement) token allow clients to construct ban masks matching account names. Servers publishing the `ACCOUNTEXTBAN` token MUST also publish the `EXTBAN` token. The value of the `ACCOUNTEXTBAN` token is a comma-separated list of names for the extended ban type which matches account names. Servers MUST support matching exact account names. Servers MAY support matching account masks and other server-specific extensions.

<a id="examples"></a>

## Examples [🔗](#examples)

Example with the [account-tag](account-tag.md) capability enabled:

```
S: :irc.ircv3.net 005 alice EXTBAN=$,ARar ACCOUNTEXTBAN=R :are supported by this server
...
S: @account=bob :bob_!~bob1@example.org PRIVMSG #chat :I am bad
C: MODE #chat +b $R:bob
```

Example with long extban names:

```
S: :irc.ircv3.net 005 alice EXTBAN=~,a ACCOUNTEXTBAN=a,account :are supported by this server
...
C: MODE #chat +b ~account:bob
```

---

Software supporting account-extban: [InspIRCd](https://www.inspircd.org), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [bIRC](https://birc.app), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria)
