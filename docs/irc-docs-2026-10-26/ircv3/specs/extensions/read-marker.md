> Source: https://ircv3.net/specs/extensions/read-marker Captured: 2026-10-26

# Read marker

Copyright © 2022 delthas \<delthas@dille.cc>

Copyright © 2022 Simon Ser \<contact@emersion.fr>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

This specification is a work-in-progress and may have major incompatible changes without warning.

This specification may change at any time and we do not recommend implementing it in a production environment.

---

<a id="notes-for-implementing-work-in-progress-version"></a>

## Notes for implementing work-in-progress version [🔗](#notes-for-implementing-work-in-progress-version)

This is a work-in-progress specification.

Software implementing this work-in-progress specification MUST NOT use the unprefixed `read-marker` CAP name. Instead, implementations SHOULD use the `draft/read-marker` CAP name to be interoperable with other software implementing a compatible work-in-progress version. The final version of the specification will use unprefixed CAP names.

<a id="description"></a>

## Description [🔗](#description)

This document describes the format of the `read-marker` extension. This enables several clients of the same user connected to a server or bouncer to tell each other about which messages have been read in each buffer (channel or query).

This specification is intended for bouncers or servers providing chat history. It lets chat history providers know what messages a user has read, and provide that information to other clients that user has, so that they can adjust their behaviour accordingly (e.g. not send highlight notifications for messages that have already been read by the user). It’s a local read marker, not sent between different users.

These read markers mean that the actual user has read the message. This specification is _not_ about message delivery at the client socket level.

The read markers sent by a user MUST NOT be disclosed to other users by the server without an explicit opt-in.

<a id="implementation"></a>

## Implementation [🔗](#implementation)

The `read-marker` extension uses the `draft/read-marker` capability and introduces a new command, `MARKREAD`.

The `draft/read-marker` capability MAY be negotiated, and affects which messages are sent by the server as specified below.

Clients can know whether a user has already read newly received messages. For clients that display notifications about new messages or highlights, knowing when messages have been read can enable them to clear notifications for messages that were already read on another device.

Clients never have to actively get the read timestamp because it is provided to them on join and as updated by the server, except for user targets where they have to request the initial read timestamp by sending a `MARKREAD` client get command.

<a id="markread-command"></a>

### `MARKREAD` Command [🔗](#markread-command)

The `MARKREAD` command can be sent by both clients and servers.

This command has the following general syntax:

```
MARKREAD <target> [<timestamp>]
```

The `target` parameter specifies a single buffer (channel or nickname).

The `timestamp` parameter, if specified, MUST be a literal `*`, or have the format `timestamp=YYYY-MM-DDThh:mm:ss.sssZ`, as in the [server-time](server-time.md) extension.

<a id="markread-client-set-command"></a>

#### `MARKREAD` client set command [🔗](#markread-client-set-command)

```
MARKREAD <target> <timestamp>
```

When sent from a client, this command signals to the server that the last message read by the user, to the best knowledge of the client, has the specified timestamp. The timestamp MUST correspond to a previous message `time` tag. The timestamp MUST NOT be a literal `*`.

The server MUST reply to a successful `MARKREAD` client set command using a `MARKREAD` server command, or using an error message. If the provided timestamp is older than the server’s stored value, the server MUST reply to the client with a `MARKREAD` command carrying the server’s stored value.

<a id="markread-client-get-command"></a>

#### `MARKREAD` client get command [🔗](#markread-client-get-command)

```
MARKREAD <target>
```

When sent from a client, this `MARKREAD` command requests the server about the timestamp of the last message read by the user.

The server MUST reply to a successful `MARKREAD` get command using a `MARKREAD` server command, or using an error message.

<a id="markread-server-command"></a>

#### `MARKREAD` server command [🔗](#markread-server-command)

When sent from a server, the `MARKREAD` command signals to the client that the last message read by the user, to the best knowledge of the server, has the specified timestamp. In that case, the command has the following syntax:

```
MARKREAD <target> <timestamp>
```

If there is no known last message read timestamp, the `timestamp` parameter is a literal `*`. Otherwise, it is the formatted timestamp of the last read message.

<a id="command-flows"></a>

#### Command flows [🔗](#command-flows)

The server sends a `MARKREAD` command to a client in the following cases.

If the `draft/read-marker` capability is negotiated, after the server sends a server `JOIN` command to the client for a corresponding channel, the server MUST send a `MARKREAD` command for that channel. The command MUST be sent before the `RPL_ENDOFNAMES` reply for that channel following the `JOIN`.

If the `draft/read-marker` capability is negotiated, after the last read timestamp of a target changes, the server SHOULD send a `MARKREAD` command for that target to all the clients of the user.

<a id="read-timestamp-notes"></a>

#### Read timestamp notes [🔗](#read-timestamp-notes)

The last read timestamp of a target MUST only ever increase. If a client sends a `MARKREAD` command with a timestamp that is below or equal to the current known timestamp of the server, the server MUST reply with a `MARKREAD` command with the newer, previous value that was stored and ignore the client timestamp.

<a id="errors-and-warnings"></a>

#### Errors and Warnings [🔗](#errors-and-warnings)

Errors are returned using the standard replies syntax.

If the server receives a `MARKREAD` command with missing parameters, the `NEED_MORE_PARAMS` error code MUST be returned.

```
FAIL MARKREAD NEED_MORE_PARAMS :Missing parameters
```

If the selectors were invalid, the `INVALID_PARAMS` error code SHOULD be returned.

```
FAIL MARKREAD INVALID_PARAMS [invalid_parameters] :Invalid parameters
```

If the read timestamp cannot be set or returned due to an error, the `INTERNAL_ERROR` error code SHOULD be returned.

```
FAIL MARKREAD INTERNAL_ERROR the_given_target [extra_context] :The read timestamp could not be set
```

<a id="examples"></a>

### Examples [🔗](#examples)

Updating the read timestamp after the user receives and reads a message

```
[s] @time=2019-01-04T14:33:26.123Z :nick!ident@host PRIVMSG #channel :message
[c] MARKREAD #channel timestamp=2019-01-04T14:33:26.123Z
[s] :irc.host MARKREAD #channel timestamp=2019-01-04T14:33:26.123Z
```

Getting the read timestamp automatically after joining a channel when the capability is negotiated

```
[s] :nick!ident@host JOIN #channel
[s] :irc.host MARKREAD #channel timestamp=2019-01-04T14:33:26.123Z
```

Getting the read timestamp automatically for a channel without any set timestamp

```
[s] :nick!ident@host JOIN #channel
[s] :irc.host MARKREAD #channel *
```

Asking the server about the read timestamp for a particular user

```
[c] MARKREAD target
[s] :irc.host MARKREAD target timestamp=2019-01-04T14:33:26.123Z
```

<a id="implementation-considerations"></a>

## Implementation Considerations [🔗](#implementation-considerations)

Server implementations can typically store a per-target timestamp variable that stores the timestamp of the last read message. When it receives a new timestamp, it can clamp it between the last read timestamp and the current time, and broadcast the new value to all clients if it was changed.

Client implementations can know when a user has read messages by using various techniques such as when the focus shifts to their window or activity, when the messages are scrolled, when the user is idle, etc. They should not assume that any message appended to the buffer is being read by the client right now, especially when the window does not have the focus or is not visible. It is indeed a best-effort value.

Clients should typically only need to use the `MARKREAD` get client command to get the initial read timestamp of user buffers they open. They will automatically receive initial channels read timestamps and updates, as well as user target timestamp updates.

<a id="security-considerations"></a>

## Security Considerations [🔗](#security-considerations)

Servers MUST NOT leak read markers sent by a user to other users, unless the user has explicitly opted in with an unspecified mechanism (e.g. separate extension or NickServ setting).

---

Software supporting draft/read-marker: [Ergo](https://ergo.chat/), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [IRCafe](https://github.com/wodencafe/ircafe), [Mango](https://mangoirc.chat), [gamja](https://codeberg.org/emersion/gamja), [Tubes](https://tubes.pronounmail.com), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma), [soju (as Server)](https://codeberg.org/emersion/soju)
