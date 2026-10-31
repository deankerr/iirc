> Source: https://ircv3.net/specs/extensions/batch Captured: 2026-10-26

# `batch` Extension

Copyright © 2012 William Pitcock \<nenolod@dereferenced.org>

Copyright © 2014 Kythyria Tieran \<kythyria@berigora.net>

Copyright © 2014 Alexey Sokolov \<alexey-irc@asokolov.org>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This extension describes a capability which causes a new verb to be sent to clients when the IRC server wishes to designate that a series of events are related to each other.

Use-cases include visual suppression of netsplits and netjoins.

This client capability MUST be named `batch`.

<a id="the-batch-verb"></a>

## The `BATCH` verb [🔗](#the-batch-verb)

The IRC server will send a `BATCH` verb when it wants the client to begin batching events together, and send another `BATCH` verb when the transaction is concluded.

The following syntax MUST be used when starting a batch:

```
BATCH +reference-tag type [<parameter 1> [<parameter 2> ... [<parameter n>]]]
```

The following syntax MUST be used when ending a batch:

```
BATCH -reference-tag
```

The reference tag MUST be treated as an opaque identifier. Reference tag MUST contain only ASCII letters, numbers, and/or hyphen, and MUST be case-sensitive.

The `type` parameter indicates how messages are associated. The meaning of the additional parameters (if any) depend on the type.

The batched events MUST use `batch` [message tag](message-tags.md) referring to the batch’s reference tag. Messages before start and after end of a batch (including start and end messages of that batch) MUST NOT refer to that batch.

For every started batch, server MUST end that batch. Client MAY delay processing the batched events until they have received and/or processed the end of the batch.

An empty batch is allowed, and SHOULD be treated as a no-op, unless demanded otherwise by the specification for that batch type.

Start and end messages of one batch MAY refer to another batch. If they do, they both MUST have batch tag, and they MUST refer to the same batch. This means that one batch is nested to another. Client MAY delay processing messages of inner batches to the end of outermost batch.

<a id="specifications-for-batch-types"></a>

## Specifications for batch types [🔗](#specifications-for-batch-types)

Batch types are specified by IRCv3 extensions, vendor-specific types MUST be prefixed the same way as how vendor-specific capabilities are prefixed. See [capability negotiation](https://ircv3.net/specs/core/capability-negotiation) for the exact details.

The full batch type name MUST be treated as an opaque identifier.

While batch types are similar to capabilities in this aspect, unlike capabilities, batch types are not advertised by servers nor explicitly requested by clients.

Client MAY use the type to change how the messages are presented to the user, e.g. by collapsing them into one message. Client MAY ignore the type and process messages one by one. For example, that happens if the type is unknown to the client.

To submit a new batch type please follow the extension submission procedure [found here](https://ircv3.net/participation).

- [`netsplit` and `netjoin`](../batches/netsplit.md)
- [`chathistory`](../batches/chathistory.md)

<a id="examples"></a>

## Examples [🔗](#examples)

<a id="a-simple-batch"></a>

### A simple batch [🔗](#a-simple-batch)

```
:irc.host BATCH +yXNAbvnRHTRBv netsplit irc.hub other.host
@batch=yXNAbvnRHTRBv :aji!a@a QUIT :irc.hub other.host
@batch=yXNAbvnRHTRBv :nenolod!a@a QUIT :irc.hub other.host
:nick!user@host PRIVMSG #channel :This is not in batch, so processed immediately
@batch=yXNAbvnRHTRBv :jilles!a@a QUIT :irc.hub other.host
:irc.host BATCH -yXNAbvnRHTRBv
```

<a id="interleaving-batches"></a>

### Interleaving batches [🔗](#interleaving-batches)

```
:irc.host BATCH +1 example.com/foo
@batch=1 :nick!user@host PRIVMSG #channel :Message 1
:irc.host BATCH +2 example.com/foo
@batch=1 :nick!user@host PRIVMSG #channel :Message 2
@batch=2 :nick!user@host PRIVMSG #channel :Message 4
@batch=1 :nick!user@host PRIVMSG #channel :Message 3
:irc.host BATCH -1
@batch=2 :nick!user@host PRIVMSG #channel :Message 5
:irc.host BATCH -2
```

Client may show the messages on the channel in order 1,2,3,4,5, or in order 1,4,2,3,5, among others.

<a id="nested-batch"></a>

### Nested batch [🔗](#nested-batch)

```
:irc.host BATCH +outer example.com/foo
@batch=outer :irc.host BATCH +inner example.com/bar
@batch=inner :nick!user@host PRIVMSG #channel :Hi
@batch=outer :irc.host BATCH -inner
:irc.host BATCH -outer
```

Notice that PRIVMSG line will be processed when batch `outer` ends, because end of batch `inner` is tagged by batch `outer`. The order in which these two batches start doesn’t matter.

<a id="errata"></a>

## Errata [🔗](#errata)

Previous versions of this spec did not specify that the full batch type name MUST be parsed as an opaque identifier. This was added to improve client resiliency.

---

Software supporting batch: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [InspIRCd](https://www.inspircd.org), [juno](https://github.com/cooper/juno), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [senpai](https://git.sr.ht/~delthas/senpai), [Swirc](https://www.nifty-networks.net/swirc/), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Kiwi IRC](https://kiwiirc.com), [The Lounge](https://thelounge.chat/), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [jWebIRC](https://github.com/WarPigs1602/jwebirc), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [KiwiBNC (as Server)](https://github.com/kiwiirc/kiwibnc), [KiwiBNC (as Client)](https://github.com/kiwiirc/kiwibnc), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [ZNC (as Server)](https://znc.in/), [BitBot](https://github.com/jesopo/bitbot), [Limnoria](https://github.com/progval/Limnoria), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [irc-framework](https://github.com/kiwiirc/irc-framework), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [Rust irc](https://github.com/aatxe/irc), [Biboumi](https://biboumi.codeberg.page/), [j2i](https://telepath.im/projects/j2i/), [Matrix2051](https://github.com/progval/matrix2051)
