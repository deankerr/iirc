> Source: https://ircv3.net/specs/extensions/setname Captured: 2026-10-26

# `setname` Extension

Copyright © 2019 Janne Mareike Koschinski \<janne@kuschku.de>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="motivation"></a>

## Motivation [🔗](#motivation)

Historically, a user’s realname could only be set on the initial connection handshake. However, multiple IRC servers have provided independent non-standard commands to update the realname without reconnecting. This specification describes a standardised behaviour based on these existing implementations.

<a id="description"></a>

## Description [🔗](#description)

The `setname` client capability allows clients to change their realname (GECOS) on an active connection. It also allows servers to directly inform clients about such a change. This avoids a client reconnect when updating this value.

This capability MUST be referred to as `setname` at capability negotiation time.

Servers advertising the `setname` capability MUST support usage of the command even while the capability is not negotiated. Clients MUST NOT prevent users from manually using the command while the capability is not negotiated.

If a client sends a `SETNAME` command without having negotiated the capability, the server SHOULD handle it silently (with no response), as historic implementations did.

When enabled, servers MUST provide a `NAMELEN` token in `RPL_ISUPPORT` with the maximum allowed length for realnames.

The client-to-server `SETNAME` command looks as follows:

```
SETNAME :realname goes here
```

This command represents the intent to change the realname. The only, trailing parameter is the new realname. If the capability is negotiated, the client MUST assume that no change has happened until the server confirms this change.

Servers MUST check the realname for validity (taking length limits into consideration). If they accept the realname change, they MUST send the server-to-client version of the `SETNAME` message to all clients in common channels, as well as to the client from which it originated, to confirm the change has occurred.

The `SETNAME` message MUST NOT be sent to clients which do not have the `setname` capability negotiated.

The server-to-client `SETNAME` message looks as follows:

```
:nick!user@host SETNAME :realname goes here
```

This message represents that the user identified by nick!user@host has changed their realname to another value. The only, trailing parameter is the new realname.

In order to take full advantage of the `SETNAME` message, clients must be modified to support it. The proper way to do so is this:

1. Enable the `setname` capability at capability negotiation time during the login handshake.

2. On receipt of a server-to-client `SETNAME` message, update the realname portion of data structures and process channel users as appropriate.

<a id="errors"></a>

## Errors [🔗](#errors)

The server MUST use the [standard replies](standard-replies.md) extension to notify the client of failed `SETNAME` commands.

If the server rejects the realname as a result of a validation failure, it MUST send a `FAIL` message with the `INVALID_REALNAME` code.

```
FAIL SETNAME INVALID_REALNAME :Realname is not valid
```

If the server rejects the change for any other reason, it MUST send a `FAIL` message with the `CANNOT_CHANGE_REALNAME` code and an appropriate description of the reason:

```
FAIL SETNAME CANNOT_CHANGE_REALNAME :Slow down your realname changes
FAIL SETNAME CANNOT_CHANGE_REALNAME :Cannot change realname while banned from a channel
```

<a id="examples"></a>

## Examples [🔗](#examples)

Complex realname with spaces

```
C: SETNAME :Bruce Wayne <bruce@wayne.enterprises>
S: :batman!~batman@bat.cave SETNAME :Bruce Wayne <bruce@wayne.enterprises>
```

Simple realname

```
C: SETNAME Batman
S: :batman!~batman@bat.cave SETNAME Batman
```

Example with realname rejected by the server

```
C: SETNAME :Heute back ich, morgen brau ich, übermorgen hol ich der Königin ihr Kind; ach, wie gut, dass niemand weiß, dass ich Rumpelstilzchen heiß!
S: FAIL SETNAME INVALID_REALNAME :Realname is not valid
```

---

Software supporting setname: [Ergo](https://ergo.chat/), [IRCCloud Teams](https://blog.irccloud.com/private-teams-servers/), [InspIRCd](https://www.inspircd.org), [UnrealIRCd](https://www.unrealircd.org), [AdiIRC](https://www.adiirc.com), [bIRC](https://birc.app), [catgirl](https://git.causal.agency/catgirl/about/), [Circe](https://github.com/emacs-circe/circe), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Irssi](https://irssi.org), [Mango](https://mangoirc.chat), [mIRC](https://www.mirc.com), [Quassel](https://www.quassel-irc.org), [senpai](https://git.sr.ht/~delthas/senpai), [WeeChat](https://weechat.org), [ZoiteChat](https://zoitechat.org), [gamja](https://codeberg.org/emersion/gamja), [IRCCloud](https://www.irccloud.com), [The Lounge](https://thelounge.chat/), [Tubes](https://tubes.pronounmail.com), [PIRC.pl web client](https://github.com/pirc-pl/pirc-gateway), [Obby](https://github.com/obbyworld/obby), [CoreIRC](https://play.google.com/store/apps/details?id=co.aureolin.coreirc), [Goguma](https://codeberg.org/emersion/goguma), [Quasseldroid](https://quasseldroid.info/), [pounce (as Server)](https://git.causal.agency/pounce/about/), [pounce (as Client)](https://git.causal.agency/pounce/about/), [soju (as Server)](https://codeberg.org/emersion/soju), [soju (as Client)](https://codeberg.org/emersion/soju), [BitBot](https://github.com/jesopo/bitbot), [Eggdrop](https://github.com/eggheads/eggdrop), [Limnoria](https://github.com/progval/Limnoria), [irc-framework](https://github.com/kiwiirc/irc-framework), [ircrobots](https://github.com/jesopo/ircrobots/), [Kitteh IRC Client Library](https://github.com/KittehOrg/KittehIRCClientLib)
