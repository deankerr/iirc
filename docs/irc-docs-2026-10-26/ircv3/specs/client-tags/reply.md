> Source: https://ircv3.net/specs/client-tags/reply Captured: 2026-10-26

# `reply` client tag

Copyright © 2016 James Wheare \<james@irccloud.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This specification defines a client-only message tag to indicate replies to other messages

<a id="architecture"></a>

## Architecture [🔗](#architecture)

<a id="dependencies"></a>

### Dependencies [🔗](#dependencies)

Clients wishing to use this tag MUST negotiate the [`message-tags`](../extensions/message-tags.md) capability with the server. Additionally, this tag relies on messages being sent with the [`msgid`](../extensions/message-ids.md) tag. Clients SHOULD negotiate the [`echo-message`](../extensions/echo-message.md) capability in order to receive message IDs for their own messages, and therefore understand any replies.

<a id="format"></a>

### Format [🔗](#format)

The reply tag is sent by a client with the client-only prefix `+` and its value references the server provided ID of another message:

```
+reply=<msgid>
```

<a id="client-implementation-considerations"></a>

## Client implementation considerations [🔗](#client-implementation-considerations)

This section is non-normative

When displaying replies, take care with the chronology of messages. Clients might choose to display a reply message adjacent to its parent, to make a “thread” apparent. This might work well when the messages are close together in the message history, but could cause problems if there have been several intervening messages in the mean time. People following the conversation may not see a reply if it’s hoisted too far into the backlog.

In this situation, it might make more sense to leave the reply in place chronologically, but provide a way to jump to the original message instead.

<a id="examples"></a>

## Examples [🔗](#examples)

In this example, a `PRIVMSG` is sent to a channel with an ID provided by the server. A client sends a reply to this message and the server sends an echo-message back to the client.

```
S: @msgid=123 :nick!user@host PRIVMSG #channel :Hello!
C: @+reply=123 PRIVMSG #channel :Hello to you!
S: @msgid=456;+reply=123 :nick2!user2@host2 PRIVMSG #channel :Hello to you!
```

---

Software supporting +reply: [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [ZoiteChat](https://zoitechat.org), [IRCCloud](https://www.irccloud.com), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma), [Limnoria](https://github.com/progval/Limnoria), [j2i](https://telepath.im/projects/j2i/)
