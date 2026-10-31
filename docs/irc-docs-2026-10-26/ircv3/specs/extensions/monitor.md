> Source: https://ircv3.net/specs/extensions/monitor Captured: 2026-10-26

# Monitor

Copyright © 2004-2015 Lee Hardy \<lee@leeh.co.uk>

Copyright © 2013-2015 Kiyoshi Aman \<kiyoshi.aman@gmail.com>

Copyright © 2015 William Pitcock \<nenolod@dereferenced.org>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

A protocol for notification of when clients become online/offline

<a id="introduction"></a>

## Introduction [🔗](#introduction)

Currently, `ISON` requests by clients use a large amount of bandwidth. It is expected that it is more efficient for this to be done by the server at the expense of cpu cycles. This specification deprecates both the `ISON` and legacy `WATCH` extensions.

<a id="watch-vs-monitor"></a>

### `WATCH` vs. `MONITOR` [🔗](#watch-vs-monitor)

The `WATCH` implementation suffers from quite a few problems. First, the implementation of the `WATCH` command is non-standard, and differs between different vendor implementations of the `WATCH` command.

The `MONITOR` extension enhances the legacy `WATCH` command by providing documented, standardized, `ISON` style notifications instead of one numeric per watch-list entry as with `WATCH`. Further, the `MONITOR` implementation is allowed to multicast notifications to every client which has a subscription to a target whom is subject to a state change. The `MONITOR` implementation also enhances user privacy by disallowing subscription to hostmasks, allowing users to avoid nick-change stalking.

<a id="monitor-command"></a>

## `MONITOR` Command [🔗](#monitor-command)

The command used throughout this specification is `MONITOR`.

Each use of the `MONITOR` command takes a special modifier, indicating the operation being performed. The client MUST NOT attempt to specify more than one modifier. Only one special modifier may be used per `MONITOR` command.

Thus it is impossible to combine additions to the list with removals from the list – these MUST be done with two separate commands.

In commands and numerics where multiple targets may occur, the length of the target list is limited only by the buffer size of 512 chars, as defined in RFC1459.

Support of this specification is indicated by the MONITOR token in `RPL_ISUPPORT` (005). This token takes an optional parameter, of the maximum amount of targets a client may have in their monitor list. If no parameter is specified, there is no limit. A typical token would be:

```
MONITOR=100
```

For this specification, ‘target’ MUST be a valid nick as determined by the IRC daemon.

<a id="monitor--targettarget2"></a>

### `MONITOR + target[,target2]*` [🔗](#monitor--targettarget2)

Adds the given list of targets to the list of targets being monitored. Targets already in the list MUST NOT be added again.

If any of the targets being added are online, the server will generate `RPL_MONONLINE` numerics listing those targets that are online.

If any of the targets being added are offline, the server will generate `RPL_MONOFFLINE` numerics listing those targets that are offline.

<a id="monitor---targettarget2"></a>

### `MONITOR - target[,target2]*` [🔗](#monitor---targettarget2)

Removes the given list of targets from the list of targets being monitored. No output will be returned for use of this command.

<a id="monitor-c"></a>

### `MONITOR C` [🔗](#monitor-c)

Clears the list of targets being monitored. No output will be returned for use of this command.

<a id="monitor-l"></a>

### `MONITOR L` [🔗](#monitor-l)

Outputs the current list of targets being monitored. All output will use `RPL_MONLIST`, and the output will be terminated with `RPL_ENDOFMONLIST`.

<a id="monitor-s"></a>

### `MONITOR S` [🔗](#monitor-s)

Outputs for each target in the list being monitored, whether the client is online or offline. All targets that are online will be sent using `RPL_MONONLINE`, all targets that are offline will be sent using `RPL_MONOFFLINE`.

<a id="numeric-replies"></a>

## Numeric replies [🔗](#numeric-replies)

<a id="730---rpl_mononline"></a>

### 730 - `RPL_MONONLINE` [🔗](#730---rpl_mononline)

```
:<server> 730 <nick> :target[!user@host][,target[!user@host]]*
```

This numeric is used to indicate to a client that either a target has just become online, or that a target they have added to their monitor list is online.

The server MAY send a hostmask with the target.

The server may send “\*” instead of the nick (`<nick>`). (This makes it possible to send the exact same message to all clients monitoring a certain target.)

<a id="731---rpl_monoffline"></a>

### 731 - `RPL_MONOFFLINE` [🔗](#731---rpl_monoffline)

```
:<server> 731 <nick> :target[,target2]*
```

This numeric is used to indicate to a client that either a target has just left the irc network, or that a target they have added to their monitor list is offline.

The argument is a chained list of targets that are offline.

As with 730, the server may send “\*” instead of the nick (`<nick>`).

<a id="732---rpl_monlist"></a>

### 732 - `RPL_MONLIST` [🔗](#732---rpl_monlist)

```
:<server> 732 <nick> :target[,target2]*
```

This numeric is used to indicate to a client the list of targets they have in their monitor list.

<a id="733---rpl_endofmonlist"></a>

### 733 - `RPL_ENDOFMONLIST` [🔗](#733---rpl_endofmonlist)

```
:<server> 733 <nick> :End of MONITOR list
```

This numeric is used to indicate to a client the end of a monitor list.

<a id="734---err_monlistfull"></a>

### 734 - `ERR_MONLISTFULL` [🔗](#734---err_monlistfull)

```
:<server> 734 <nick> <limit> <targets> :Monitor list is full.
```

This numeric is used to indicate to a client that their monitor list is full, so the command failed. The `<limit>` parameter is the maximum number of targets a client may have in their list, the `<targets>` parameter is the list of targets, as the client sent them, that cannot be added.

<a id="errata"></a>

## Errata [🔗](#errata)

- Earlier version of this spec had RPL\_MONONLINE only sending nicknames, This did not match existing implementations.

---

Software supporting Monitor: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [ircd-hybrid](https://github.com/ircd-hybrid/ircd-hybrid), [InspIRCd](https://www.inspircd.org), [Solanum](https://github.com/solanum-ircd/solanum), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [glirc](https://hackage.haskell.org/package/glirc), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Mozilla Thunderbird](https://www.thunderbird.net/), [senpai](https://git.sr.ht/~delthas/senpai), [Textual](https://www.codeux.com/textual), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [Obby](https://github.com/obbyworld/obby), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Palaver](https://palaverapp.com/), [IRCCloud (as Server)](https://blog.irccloud.com/bouncer/), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [Communi](https://communi.github.io), [girc](https://github.com/lrstanley/girc), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib), [pydle](https://pypi.python.org/pypi/pydle), [Rust irc](https://github.com/aatxe/irc), [Warren](https://github.com/WillowChat/Warren)
