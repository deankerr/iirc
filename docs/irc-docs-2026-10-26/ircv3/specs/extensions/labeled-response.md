> Source: https://ircv3.net/specs/extensions/labeled-response Captured: 2026-10-26

# Labeled Responses

Copyright © 2015 Alexey Sokolov \<alexey-irc@asokolov.org>

Copyright © 2016-2020 James Wheare \<james@irccloud.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This specification adds a new message tag sent by clients and repeated by servers to correlate responses with a specific request.

<a id="motivation"></a>

## Motivation [🔗](#motivation)

Certain client actions can result in responses from the server that vary in interpretation depending on how they were triggered, or otherwise lack a robust way to correlate with local state. Clients have historically needed to keep track of additional local state and/or apply comparison heuristics to server responses to correlate these appropriately.

Labeled responses enable a much simpler form of correlation by using a single id attached to a client request and repeated by the server in its response.

Additionally, labeled responses allow bouncers with multiple connected clients to direct responses (such as WHOIS queries or error messages, see examples) to the correct recipient.

<a id="architecture"></a>

## Architecture [🔗](#architecture)

<a id="dependencies"></a>

### Dependencies [🔗](#dependencies)

This specification depends on the [`batch`](batch.md) capability which MUST be negotiated to use labeled responses. The order of capability negotiation is not significant and MUST not be enforced.

This specification also uses the [message tags](message-tags.md) framework.

<a id="capabilities"></a>

### Capabilities [🔗](#capabilities)

This specification adds the `labeled-response` capability.

Clients requesting this capability indicate that they are capable of handling the message tag, batch type, and `ACK` response described below from servers.

Servers advertising this capability indicate that they are capable of handling the message tag described below from clients, and will use the same tag and value in their response. They will also send the batch type and `ACK` response described below where required.

<a id="batch-types"></a>

### Batch types [🔗](#batch-types)

This specification adds the `labeled-response` batch type, described below.

<a id="tags"></a>

### Tags [🔗](#tags)

This specification adds the `label` message tag, which has a required value.

This tag MAY be sent by a client for any messages that need to be correlated with a response from the server.

For any message received from a client that includes this tag, the server MUST include the same tag and value in any response required from this message where it is feasible to do so. Servers MUST include the tag in exactly one logical message.

If a response consists of more than one message, a batch MUST be used to group them into a single logical response. The start of the batch MUST be tagged with the `label` tag. The batch type MUST be one of:

- An existing type applicable to the entire response
- `labeled-response`

When a client sends a message to itself, the server MUST NOT include the label tag, except for any acknowledgment sent with the [`echo-message`](echo-message.md) mechanism. This allows clients to differentiate between the echoed message response, and the delivered message.

<a id="tag-value"></a>

#### Tag value [🔗](#tag-value)

The tag value is chosen by the client and MUST be treated as an opaque identifier. The client SHOULD NOT reuse a tag value until it has received a complete response for that value from the server. The value MUST NOT exceed 64 bytes.

<a id="the-ack-response"></a>

### The `ACK` response [🔗](#the-ack-response)

Servers MUST respond with a labeled `ACK` message when a client sends a labeled command that normally produces no response. It takes no additional parameters and is defined as follows

```
:irc.example.com ACK
```

<a id="client-implementation-considerations"></a>

## Client implementation considerations [🔗](#client-implementation-considerations)

This section is non-normative.

There are some cases where a server might not produce a labeled response, or even an `ACK`. Consider the example of an asynchronous command such as a remote `WHOIS nick nick` query that’s forwarded to one or more other servers. If the command fails, for instance due to a netsplit, there are several potential outcomes:

- the local server notices that the remote server is unavailable and sends a labeled `ACK` instead of a `WHOIS` response.
- the local server is unable to tell whether the remote server will respond or not and sends neither an `ACK` nor a `WHOIS` response.
- the local server has already begun responding when the netsplit occurs, so the batched response ends early.
- the local server receives a response from the remote server after the netsplit resolves, and sends a `WHOIS` response to the client, potentially without any label.

Clients should handle these cases as they would normally for a server without support for labeled responses.

In the case of `echo-message` (see example below), a client can use labeled responses to correlate a server’s acknowledgment of their own messages with a temporary message displayed locally. The temporary message can be displayed to the user immediately in a pending state to reduce perceived lag, and then removed once a labeled response from the server is received.

When a client sends a private message to its own nick, `echo-message` will result in duplicate messages being sent by the server, as both sent and received messages. Labeled responses allow clients to deduplicate these messages in one of two ways:

1.  Ignore the labeled message, and use any unlabeled message as acknowledgment for all sent messages to clear temporary local messages.
2.  Ignore the unlabeled message.

Both methods assume that the server will acknowledge all successful messages, or return a labeled error response, but differ in their attitude towards the semantics of sending and receiving.

<a id="bouncer-implementation-considerations"></a>

## Bouncer implementation considerations [🔗](#bouncer-implementation-considerations)

This section is non-normative.

Bouncers might choose to restrict routing labeled responses to some or all of their clients. For example, the response to a labeled WHOIS request might only be routed back to the originating client. However, an `echo-message` response might be routed to all clients. The bouncer might also choose to make labeled requests to the server on its own behalf, without routing any response to clients.

To avoid label value clashes from multiple connected clients, a bouncer could choose to modify the client supplied label, for instance, by adding a client id prefix. In this case, the modified label would be converted back to its original form before routing the response back to the client.

<a id="examples"></a>

## Examples [🔗](#examples)

This section is non-normative.

`echo-message` showing a message that has been modified by the server to remove formatting

```
Client: @label=pQraCjj82e PRIVMSG #channel :\x02Hello!\x02
Server: @label=pQraCjj82e :nick!user@host PRIVMSG #channel :Hello!
```

---

Failed `PRIVMSG` with `ERR_NOSUCHNICK`

```
Client: @label=dc11f13f11 PRIVMSG nick :Hello
Server: @label=dc11f13f11 :irc.example.com 401 * nick :No such nick/channel
```

---

`WHOIS` response using a batch

```
Client: @label=mGhe5V7RTV WHOIS nick
Server: @label=mGhe5V7RTV :irc.example.com BATCH +NMzYSq45x labeled-response
Server: @batch=NMzYSq45x :irc.example.com 311 client nick ~ident host * :Name
...
Server: @batch=NMzYSq45x :irc.example.com 318 client nick :End of /WHOIS list.
Server: :irc.example.com BATCH -NMzYSq45x
```

A server replying with `ACK` where no response is required

```
Server: PING :foobar
Client: @label=abc PONG :foobar
Server: @label=abc :irc.example.com ACK
```

<a id="alternatives"></a>

## Alternatives [🔗](#alternatives)

For the use case of bouncers directing query responses to the appropriate client, there exists prior art in the form of the znc module [route\_replies](http://wiki.znc.in/Route_replies). The complexities and limitations of that module were a primary motivation for the standardised approach described in this specification.

---

Software supporting labeled-response: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [InspIRCd](https://www.inspircd.org), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [senpai](https://git.sr.ht/~delthas/senpai), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Client)](https://codeberg.org/emersion/soju), [BitBot](https://github.com/jesopo/bitbot), [Limnoria](https://github.com/progval/Limnoria), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [Matrix2051](https://github.com/progval/matrix2051)
