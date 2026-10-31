> Source: https://ircv3.net/specs/extensions/utf8-only Captured: 2026-10-26

# UTF8ONLY ISUPPORT token

Copyright © 2021 Daniel Oaks \<daniel@danieloaks.net>

Copyright © 2021 Shivaram Lingamneni \<slingamn@cs.stanford.edu>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

IRC predates the Unicode standard. Consequently, although UTF-8 has been widely adopted on IRC, clients cannot assume that all IRC data is UTF-8. This specification defines a way for servers to advertise that they only allow UTF-8 on their network, letting clients change their processing of outgoing and incoming messages accordingly.

<a id="the-utf8only-isupport-token"></a>

## The `UTF8ONLY` ISUPPORT token [🔗](#the-utf8only-isupport-token)

This specification introduces a new token `UTF8ONLY` that servers can include in their [ISUPPORT](../../../modern/client-protocol.md#feature-advertisement) (`005`) output. Servers publishing this token MUST NOT relay content (such as `PRIVMSG` or `NOTICE` message data, channel topics, or realnames) containing non-UTF-8 data to clients. Clients implementing this specification MUST NOT send non-UTF-8 data to the server once they have seen this token. Server handling of such messages is implementation-defined; for example, they MAY send the `INVALID_UTF8` code described below, or respond in some other way.

If a client implementing this specification sees this token, they MUST set their outgoing encoding to UTF-8 without requiring any user intervention. This allows clients to work transparently on networks that only allow UTF-8 traffic.

<a id="the-invalid_utf8-standard-replies-code"></a>

## The `INVALID_UTF8` standard replies code [🔗](#the-invalid_utf8-standard-replies-code)

This is a code that can be used with the [standard replies](standard-replies.md) specification. When sent with the `FAIL` command, it indicates that the client’s message was rejected because it contained invalid UTF-8 data. When sent with the `WARN` command, it indicates that the message was modified but still accepted.

<a id="examples"></a>

## Examples [🔗](#examples)

```
Client: PRIVMSG #ircv3 :<non-utf-8 message>
Server: FAIL PRIVMSG INVALID_UTF8 :Message rejected, your IRC software MUST use UTF-8 encoding on this network
```

```
Client: USER u s e :<non-utf8 realname>
Server: FAIL USER INVALID_UTF8 :Message rejected, your IRC software MUST use UTF-8 encoding on this network
```

```
Client: PRIVMSG #ircv3 :<non-utf-8 message>
Server: WARN PRIVMSG INVALID_UTF8 :Your message was not correctly encoded as UTF-8 and had to be modified
```

<a id="implementation-considerations"></a>

## Implementation considerations [🔗](#implementation-considerations)

This section is non-normative.

Implementations must ensure that if they truncate messages to meet a length limit, they do not do so in the middle of a UTF-8-encoded codepoint.

---

Software supporting UTF8ONLY: [Ergo](https://ergo.chat/), [InspIRCd](https://www.inspircd.org), [juno](https://github.com/cooper/juno), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [KVIrc](https://www.kvirc.net), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Srain](https://srain.silverrainz.me), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [Limnoria](https://github.com/progval/Limnoria), [Matrix2051](https://github.com/progval/matrix2051)
