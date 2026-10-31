> Source: https://ircv3.net/specs/client-tags/channel-context Captured: 2026-10-26

# `channel-context` client tag

Copyright © 2022 delthas \<delthas@dille.cc>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This specification defines a client-only message tag to indicate the channel a private PRIVMSG or NOTICE should be displayed in.

<a id="motivation"></a>

## Motivation [🔗](#motivation)

Responding to PRIVMSG messages in channels with NOTICE messages in private is a widely-used IRC practice for bots, in order to prevent flooding a channel with messages only useful for a single user. Clients have developed heuristics for matching incoming private NOTICE to their channel context, but these heuristics are error-prone and difficult to implement for past messages with CHATHISTORY.

This tag enables clients to systematically know in which channel a private PRIVMSG or NOTICE should be displayed, because the sender can now communicate that information in the message.

<a id="architecture"></a>

## Architecture [🔗](#architecture)

<a id="dependencies"></a>

### Dependencies [🔗](#dependencies)

Clients wishing to use this tag MUST negotiate the [`message-tags`](../extensions/message-tags.md) capability with the server.

<a id="format"></a>

### Format [🔗](#format)

The channel-context tag is sent by a client with the client-only prefix `+`. The value MUST be a valid channel name.

```
+channel-context=<channel>
```

This tag MUST be attached to PRIVMSG and NOTICE messages to users only. Clients MUST ignore this tag if it is not attached to a private PRIVMSG or NOTICE message or if its value is not a valid channel name.

<a id="client-implementation-considerations"></a>

## Client implementation considerations [🔗](#client-implementation-considerations)

This section is non-normative.

When clients receive a private PRIVMSG or NOTICE message from a user with this tag, they can display that message in the buffer specified in the tag, as if it was a channel message.

To prevent abuse, client implementations might allow users to hide these messages when the sender does not belong to the specified channel.

<a id="examples"></a>

## Examples [🔗](#examples)

In this example, user `me` requests documentation from bots in channel `#chan`, then gets the response in private, but in the context of that channel, using `channel-context`.

```
C: PRIVMSG #chan :!help
S: @+channel-context=#chan :bot!bot@bot NOTICE me :I'm helping.
```

---

Software supporting +channel-context: [bIRC](https://birc.app), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [Obby](https://github.com/obbyworld/obby), [Limnoria](https://github.com/progval/Limnoria)
