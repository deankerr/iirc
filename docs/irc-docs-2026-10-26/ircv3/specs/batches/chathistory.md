> Source: https://ircv3.net/specs/batches/chathistory Captured: 2026-10-26

# `chathistory` Batch Type

Copyright © 2015 Sadie Powell \<sadie@sadiepowell.dev>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

This document describes the format of the `chathistory` batch type.

The `chathistory` batch type takes one parameter. This parameter contains the target of messages within the batch. The target MUST either be the nick of the remote client for private messages or the name of a channel which the local client is in for public messages.

When a client which has enabled the [`batch` capability](../extensions/batch.md) performs an action which requires chat history to be relayed to it (e.g. joining a channel with InspIRCd’s `chanhistory` mode enabled) the server SHOULD put all PRIVMSGs and NOTICEs into a single `chathistory` batch. If the client has also enabled the [`server-time` capability](../extensions/server-time.md) then messages inside the batch MUST be tagged with the time at which they were originally sent.

<a id="examples"></a>

## Examples [🔗](#examples)

<a id="channel-message"></a>

### Channel Message [🔗](#channel-message)

```
:irc.host BATCH +sxtUfAeXBgNoD chathistory #channel
@batch=sxtUfAeXBgNoD;time=2015-06-26T19:40:31.230Z :foo!foo@example.com PRIVMSG #channel :I like turtles.
@batch=sxtUfAeXBgNoD;time=2015-06-26T19:43:53.410Z :bar!bar@example.com NOTICE #channel :Tortoises are better.
@batch=sxtUfAeXBgNoD;time=2015-06-26T19:48:18.140Z :irc.host PRIVMSG #channel :Squishy animals are inferior to computers.
:irc.host BATCH -sxtUfAeXBgNoD
```

<a id="private-message"></a>

### Private Message [🔗](#private-message)

```
:irc.host BATCH +sxtUfAeXBgNoD chathistory remote
@batch=sxtUfAeXBgNoD;time=2015-06-26T19:40:31.230Z :remote!foo@example.com PRIVMSG local :I like turtles.
@batch=sxtUfAeXBgNoD;time=2015-06-26T19:43:53.410Z :local!bar@example.com PRIVMSG remote :Tortoises are better.
:irc.host BATCH -sxtUfAeXBgNoD
```

---
