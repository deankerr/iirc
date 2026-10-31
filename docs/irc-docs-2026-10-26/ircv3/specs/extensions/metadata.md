> Source: https://ircv3.net/specs/extensions/metadata Captured: 2026-10-26

# Metadata

Copyright © 2012 Kiyoshi Aman \<kiyoshi.aman@gmail.com>

Copyright © 2015-2016 Attila Molnar \<attilamolnar@hush.com>

Copyright © 2018 James Wheare \<james@irccloud.com>

Copyright © 2021 Daniel Oaks \<daniel@danieloaks.net>

Copyright © 2022 Valerie Pond \<v.a.pond@outlook.com>

Copyright © 2022-2023 Val Lorentz \<progval+ircv3@progval.net>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

This specification is a work-in-progress and may have major incompatible changes without warning.

This specification may change at any time and we do not recommend implementing it in a production environment.

---

<a id="notes-for-implementing-work-in-progress-version"></a>

## Notes for implementing work-in-progress version [🔗](#notes-for-implementing-work-in-progress-version)

This is a work-in-progress specification.

Software implementing this work-in-progress specification MUST NOT use the unprefixed `metadata-2` capability name. Instead, implementations SHOULD use the `draft/metadata-2` capability name to be interoperable with other software implementing a compatible work-in-progress version.

The final version of the specification will use an unprefixed capability name.

<a id="introduction"></a>

## Introduction [🔗](#introduction)

It is useful to associate metadata with one’s IRC presence, e.g. to make one’s homepage or non-IRC contact details more discoverable. There are several mechanisms for doing this, but they normally rely on the presence of services and aren’t really suitable for transient metadata like a user’s current location.

This feature lays out a command that can be used to set metadata, and a message that can be used to receive metadata updates from the server.

<a id="concepts"></a>

## Concepts [🔗](#concepts)

Clients and channels can both contain metadata. Metadata acts as a key:value store (for example, the `display-name` key on a user, or the `url` key on a channel).

Clients can [set/delete](#metadata-set) metadata on themselves, and on channels they administer. Privileged users (e.g. network admins) may be able to set certain metadata on other users, and set special keys on themselves or channels.

Server administrators can setup lists of allowed or blocked keys, and may also restrict the setting/viewing of keys depending on whether the user is an admin, what kind of admin they are, etc (see the `Visibility` field).

On joining a server, clients have to configure their ‘metadata key [subscriptions](#metadata-sub)’. This is a list of which keys the client understands and wants to get updates about (for example, they may subscribe to a `status` key if they support user-set statuses). By default, this subscription list is empty.

When metadata is updated, users who have subscribed to the changed key will receive a [`METADATA` message](#metadata-server-message) notifying them of the change.

For channel metadata, this applies only to subscribers who are members of the updated channel. For user metadata, this applies only to subscribers who either share a channel with the updated user or are [monitoring](monitor.md#monitor-command) them.

On joining a channel, users will get the channel’s current metadata sent to them with `METADATA` messages, and get the same information for all users who are in the channel. Specifically, they get that information for the keys they are subscribed to. The server may also tell them to request that information [at a later time](#metadata-sync).

<a id="relation-with-other-specifications"></a>

## Relation with other specifications [🔗](#relation-with-other-specifications)

This specification depends on the [`batch`](batch.md) capability which MUST be negotiated to use `draft/metadata-2`. The order of capability negotiation is not significant and MUST NOT be enforced.

This specification also uses the [standard replies](standard-replies.md) framework.

Clients MUST NOT request both `metadata-notify` and `draft/metadata-2`. Servers MUST NOT accept these requests either.

<a id="draftmetadata-2-capability"></a>

## `draft/metadata-2` Capability [🔗](#draftmetadata-2-capability)

The `draft/metadata-2` capability indicates that a server supports metadata, and provides any limits and information about the system that clients must be aware of. Clients MUST request this capability in order to receive [`METADATA` notifications](#notifications).

The ABNF format of the `metadata` capability is:

```
capability ::= 'metadata' ['=' tokens]
tokens     ::= token [',' token]*
token      ::= key ['=' value]
key        ::= <sequence of one or more a-z0-9_./->
value      ::= <utf8>
```

These are the defined tokens:

- `before-connect`: if present, indicates the server supports `METADATA` commands during connection registration
- `max-subs`: the maximum number of keys a client is allowed in its subscription list. See the [`SUB`](#metadata-sub) subcommand for more details.
- `max-keys`: the maximum number of keys a client is allowed to set on its own nickname.
- `max-value-bytes`: the maximum size of values a client is allowed to set. Servers MAY send longer values.

Clients MUST silently ignore any unknown tokens.

<a id="keys-and-values"></a>

## Keys and Values [🔗](#keys-and-values)

Key names are restricted to the ranges `a-z`, `0-9`, and `_./-`. The empty string is an invalid value.

Values can take any form, but MUST be encoded using UTF-8. The empty string is a valid value.

The expected handling of individual metadata keys SHOULD be [defined and listed in the IRCv3 extension registry](https://ircv3.net/registry).

<a id="batch-types"></a>

## Batch types [🔗](#batch-types)

This specification adds the `metadata` and `metadata-subs` batch types.

The `metadata` batch type MUST be sent to clients under the following circumstances:

- To enclose 0 or more `761 RPL_KEYVALUE` responses to `METADATA GET` or `METADATA LIST`
- To enclose 0 or more `METADATA` commands in response to `METADATA SYNC`
- To enclose 0 or more `METADATA` commands in response to a metadata-capable client completing connection registration and receiving its own metadata

It takes one parameter and clients MUST ignore extra parameters. This parameter contains the target for which the metadata was requested, allowing the client to correctly process empty batches. Since a batch sent in response to `METADATA SYNC` on a channel may contain metadata on users as well as the channel itself, clients MUST NOT assume that all metadata in the batch applies to the entity referenced in the batch parameter.

The `metadata-subs` batch type MUST be sent to clients in response to the `SUBS` subcommand, to enclose 0 or more `772 RPL_METADATASUBS` replies. It takes no parameters and clients MUST ignore any parameters sent.

<a id="notifications"></a>

## Notifications [🔗](#notifications)

Clients can either be subscribed to a key, or not subscribed to it. By default, clients are not subscribed to any keys. They can subscribe and unsubscribe from keys using the [`SUB`](#metadata-sub) and [`UNSUB`](#metadata-unsub) subcommands. The server MUST allow clients to subscribe to any valid keys, including privileged keys the client cannot access at the time of subscription.

The client will receive [`METADATA` messages](#metadata-server-message) about the keys they are subscribed to. They can also use the [`GET`](#metadata-get) and [`LIST`](#metadata-list) subcommands to receive information about keys they are not subscribed to.

Clients automatically receive metadata updates for:

- themselves (excluding changes they make themselves)
- channels they are joined to,
- other clients in the channels they are joined to, and
- users they are currently monitoring.

Servers MUST reply to erroneous requests using [Standard Replies](standard-replies.md)

---

If a channel/user the client is receiving updates for changes one of the keys the client is subscribed to, they will receive a [`METADATA` message](#metadata-server-message) notifying them of the change. Clients MAY also receive metadata notifications for keys they have not subscribed to, or even when they have not subscribed to any keys.

Here are additional cases where clients will receive `METADATA` messages:

- If the `metadata` capability was negotiated during connection registration, clients receive their current metadata (any metadata stored by the server or by services, plus any metadata set by the client during connection registration via `before-connect`) in a `metadata` batch with their own nick as target as part of the registration burst, i.e. before `RPL_ENDOFMOTD` or `ERR_NOMOTD`. If none exists, the server MUST send an empty batch instead.
- When subscribing to a key, clients SHOULD receive the current value of that key for channels/users they are receiving updates for.
- Clients SHOULD receive the current values of keys they are subscribed to when they [`MONITOR`](monitor.md#monitor-command) a user, or when one of their monitored users comes online.

<a id="postponed-synchronization"></a>

## Postponed synchronization [🔗](#postponed-synchronization)

If the client joins a large channel, or the client is already on some channels and enables the `metadata` capability, the server may not be able to send the client all current metadata for their targets.

In this case, the server MUST respond with a `RPL_METADATASYNCLATER` numeric instead of propagating the current metadata of the targets. This numeric indicates that the specified target has some metadata set that the client SHOULD request synchronization of at a later time.

The client can use the [`SYNC`](#metadata-sync) subcommand to request the sync of metadata for the given target. If the `[<RetryAfter>]` is given, the client SHOULD wait at least that many seconds before sending the sync request.

<a id="metadata-server-message"></a>

## METADATA server message [🔗](#metadata-server-message)

Clients that request the `metadata` capability MUST be able to handle incoming `METADATA` messages. After negotiating this capability, servers MAY send this message to clients at any time.

The format of the `METADATA` server message is:

```
METADATA <Target> <Key> <Visibility> <Value>
```

`Target` is a valid nickname or channel name.

`Key` is a valid key name

`Visibility` is an asterisk (`*`) for keys visible to everyone, or an implementation-defined value which describes the key’s visibility status; for instance, it MAY be a permission level or flag. (TODO should we define a prefix like STATUSMSG for this value?)

`Value` is a UTF-8 encoded value.

<a id="metadata-client-command"></a>

## METADATA client command [🔗](#metadata-client-command)

```
METADATA <Target> <Subcommand> [<Param 1> ... [<Param n>]]
```

`Target` is a valid nickname or channel name. Clients SHOULD use the asterisk symbol (`*`) when targeting their own nickname.

`Subcommand` is one of the subcommands listed below. The allowed params are described in each subcommand description.

Clients MAY use this command during connection registration if the server advertises the `before-connect` token. Clients that have not completed connection registration MUST use `*` to target themselves, since they have not been assigned a nickname, even if they sent a `NICK` command.

<a id="metadata-get"></a>

### METADATA GET [🔗](#metadata-get)

```
METADATA <Target> GET key1 key2 ...
```

This subcommand lets clients lookup keys on the given target.

Multiple keys may be given.

The response will be a `metadata` batch containing:

- `RPL_KEYVALUE`
- `RPL_KEYNOTSET`
- `FAIL METADATA KEY_INVALID`

for every key in order.

Servers MAY replace metadata which is considered not visible for the requesting user, with `RPL_KEYNOTSET` or with `FAIL METADATA KEY_NO_PERMISSION`.

_Failures_: `KEY_INVALID`, `KEY_NO_PERMISSION`

<a id="metadata-list"></a>

### METADATA LIST [🔗](#metadata-list)

```
METADATA <Target> LIST
```

This subcommand lists all of the target’s currently-set metadata keys along with their values.

If the target is valid, the response is a `metadata` batch containing zero or more `RPL_KEYVALUE` events. If the target is not valid, ONLY a `FAIL METADATA INVALID_TARGET` reply is sent.

Servers MAY omit metadata which is considered not visible for the requesting user, or replace it with `FAIL METADATA KEY_NO_PERMISSION` within the batch.

_Failures_: `FAIL METADATA KEY_NO_PERMISSION`.

<a id="metadata-set"></a>

### METADATA SET [🔗](#metadata-set)

```
METADATA <Target> SET <Key> [:Value]
```

This subcommand sets the key on the target to the given value. If no value is given, the key is removed.

If the key is invalid, the server responsds with `FAIL METADATA KEY_INVALID` and fails the request.

If the key is valid, but not set, and the client tries to remove the key, the server responds with `FAIL METADATA KEY_NOT_SET` and fails the request.

If the user cannot set keys on the given target, the server responds with `FAIL METADATA KEY_NO_PERMISSION` and fails the request.

Servers MAY respond to certain keys considered not settable by the requesting user, or otherwise disallowed by the server, with `FAIL METADATA KEY_NO_PERMISSION` and fail the request.

Servers MAY respond with `FAIL METADATA RATE_LIMITED` and fail the request. When a client receives `FAIL METADATA RATE_LIMITED`, it SHOULD retry the `METADATA SET` request at a later time. If the `FAIL METADATA RATE_LIMITED` event contains the `<RetryAfter>` parameter, the parameter value MUST be a positive integer indicating the minimum number of seconds the client should wait before retrying the request.

If the request is successful, the server carries out the requested change and responds with one `RPL_KEYVALUE` event, representing the new value if any, or `RPL_KEYNOTSET` if no value is set. This new value MAY differ from the one sent by the client.

_Failures_: `FAIL METADATA LIMIT_REACHED`, `FAIL METADATA KEY_INVALID`, `FAIL METADATA KEY_NO_PERMISSION`, `FAIL METADATA RATE_LIMITED`, `FAIL METADATA KEY_NOT_SET`, `FAIL METADATA VALUE_INVALID`

<a id="metadata-clear"></a>

### METADATA CLEAR [🔗](#metadata-clear)

```
METADATA <Target> CLEAR
```

This subcommand removes all metadata from the target, equivalently to using `METADATA SET` on all currently-set keys with no value.

If the user cannot clear keys on the given target, the server responds with `FAIL METADATA KEY_NO_PERMISSION` with an asterisk (`*`) in the `<Key>` field and fails the request.

Servers MAY omit certain keys which are considered not settable by the requesting user, or respond with `FAIL METADATA KEY_NO_PERMISSION` for each of those keys.

If the request is successful, the server responds with a `metadata` batch containing one `RPL_KEYNOTSET` event per cleared key, and failure messages if any.

_Failures_: `FAIL METADATA KEY_NO_PERMISSION`

<a id="metadata-sub"></a>

### METADATA SUB [🔗](#metadata-sub)

```
METADATA * SUB <key1> [<key2> ...]
```

This subcommand lets clients subscribe to updates for the given keys.

The server MUST process each key in order, as the client uses this order to determine which keys they were and were not able to subscribe to. Clients SHOULD send keys in order of preference.

The server processes each key in order, and:

> If the client has subscribed to too many keys, the server does not process any further keys in the subcommand. The `<key>` parameter of the `FAIL METADATA TOO_MANY_SUBS` reply MUST be this first key that the client could not subscribe to (so the client knows all keys sent after that one were not processed).
>
> If the client successfully subscribes to a key, or is already subscribed to a requested key, that key MUST appear in a `RPL_METADATASUBOK` reply numeric.
>
> If the key’s name is invalid, the server sends a `FAIL METADATA KEY_INVALID` reply to the client and continues processing keys.
>
> If the client does not have permission to view a given key, the server sends a `FAIL METADATA KEY_NO_PERMISSION` reply to the client and continues processing keys. However, the subscription MUST still be successful, and that key MUST appear in a `RPL_METADATASUBOK` reply numeric. In this case, the `FAIL METADATA KEY_NO_PERMISSION` reply serves as a warning indicating that the client will not receive `METADATA` messages about this key unless it gains the necessary (implementation defined) privileges later.

Once the server is finished processing keys, it responds with:

- zero or more of this numeric in any order: `RPL_METADATASUBOK`,
- zero or more of these standard reply codes: `FAIL METADATA KEY_INVALID`, `FAIL METADATA KEY_NO_PERMISSION`
- and MAY respond with one `FAIL METADATA TOO_MANY_SUBS` reply.

<a id="metadata-unsub"></a>

### METADATA UNSUB [🔗](#metadata-unsub)

```
METADATA * UNSUB <key1> [<key2> ...]
```

This subcommand lets clients unsubscribe from updates for the given keys.

Servers process the given keys, and:

> If the client successfully unsubscribes from a key, or is not subscribed to a requested key, that key MUST appear in a `RPL_METADATAUNSUBOK` reply numeric.
>
> If the key’s name is invalid, the server sends a `FAIL METADATA KEY_INVALID` reply to the client and continues processing keys.

Once the server is finished processing keys, it responds with:

- zero or more of this numeric in any order: `RPL_METADATAUNSUBOK`
- zero of more of this standard reply: `FAIL METADATA KEY_INVALID`

<a id="metadata-subs"></a>

### METADATA SUBS [🔗](#metadata-subs)

```
METADATA * SUBS
```

This subcommand returns which keys the client is currently subscribed to.

The server responds with a `metadata-subs` batch containing zero or more `RPL_METADATASUBS` numerics. The server MAY return the keys in any order. The server MUST NOT list the same key multiple times in a response to this subcommand.

<a id="metadata-sync"></a>

### METADATA SYNC [🔗](#metadata-sync)

```
METADATA <Target> SYNC
```

Clients use this subcommand to receive all subscribed metadata from the given target. If the target is a channel, it also syncs the metadata for all other users in that channel.

If the sync cannot be performed at this time (due to load or other implementation-defined details), the server responds with a `RPL_METADATASYNCLATER`. If the sync can be performed, the server responds with a `metadata` batch containing zero or more METADATA events.

For details, please see the [postponed synchronization](#postponed-synchronization) section.

<a id="standard-replies"></a>

## Standard Replies [🔗](#standard-replies)

The following Standard Replies codes are defined with these parameters:

| Code                 | Parameters                                      |
| -------------------- | ----------------------------------------------- |
| `INVALID_TARGET`     | `<Target> :invalid metadata target`             |
| `KEY_INVALID`        | `<InvalidKey> :invalid key`                     |
| `SUBCOMMAND_INVALID` | `<SubCommand> :invalid subcommand`              |
| `KEY_NO_PERMISSION`  | `<Target> <Key> :permission denied`             |
| `KEY_NOT_SET`        | `<Target> <Key> :key not set`                   |
| `LIMIT_REACHED`      | `<Target> :metadata limit reached`              |
| `RATE_LIMITED`       | `<Target> <Key> <RetryAfter> :too many changes` |
| `TOO_MANY_SUBS`      | `<Key> :too many subscriptions`                 |
| `VALUE_INVALID`      | `:value is too long or not UTF8`                |

Reference table of Standard Replies codes and the `METADATA` subcommands or any other commands that produce them:

| Code                 | GET | LIST | SET | CLEAR | SUB | UNSUB | SUBS | SYNC | Other |
| -------------------- | --- | ---- | --- | ----- | --- | ----- | ---- | ---- | ----- |
| `INVALID_TARGET`     | \*  | \*   | \*  | \*    | \*  | \*    | \*   | \*   |       |
| `KEY_INVALID`        | \*  |      | \*  |       | \*  | \*    |      |      |       |
| `VALUE_INVALID`      |     |      | \*  |       |     |       |      |      |       |
| `SUBCOMMAND_INVALID` |     |      |     |       |     |       |      |      | \*    |
| `KEY_NO_PERMISSION`  | \*  | \*   | \*  |       | \*  | \*    |      |      |       |
| `KEY_NOT_SET`        |     |      | \*  |       |     |       |      |      |       |
| `LIMIT_REACHED`      |     |      | \*  |       |     |       |      |      |       |
| `RATE_LIMITED`       |     |      | \*  |       |     |       |      |      |       |
| `TOO_MANY_SUBS`      |     |      |     |       | \*  |       |      |      |       |

Each subcommand section describes the reply and error numerics it expects from the server, but here are brief descriptions of numerics that are used for multiple subcommands:

<a id="examples"></a>

### Examples [🔗](#examples)

- `FAIL METADATA TARGET_INVALID ExampleUser!lol :Invalid target.` when a client refers to an invalid target.
- `FAIL METADATA KEY_INVALID %key% :That is not a valid key.` when a client refers to an invalid key.
- `FAIL METADATA KEY_NO_PERMISSION %target% %key% :You do not have permission to set %key% on %target%` when a client attempts to access or set a key on a target when they lack sufficient permission.
- `FAIL METADATA SUBCOMMAND_INVALID destr0y :Invalid subcommand.` when a client calls a `METADATA` subcommand which is not defined.

<a id="numerics"></a>

## Numerics [🔗](#numerics)

The following numerics 760 through 775 are reserved for metadata, with these labels and parameters:

| No. | Label                   | Parameters                             |
| --- | ----------------------- | -------------------------------------- |
| 760 | `RPL_WHOISKEYVALUE`     | `<Target> <Key> <Visibility> :<Value>` |
| 761 | `RPL_KEYVALUE`          | `<Target> <Key> <Visibility> :<Value>` |
| 766 | `RPL_KEYNOTSET`         | `<Target> <Key> :key not set`          |
| 770 | `RPL_METADATASUBOK`     | `<Key1> [<Key2> ...]`                  |
| 771 | `RPL_METADATAUNSUBOK`   | `<Key1> [<Key2> ...]`                  |
| 772 | `RPL_METADATASUBS`      | `<Key1> [<Key2> ...]`                  |
| 774 | `RPL_METADATASYNCLATER` | `<Target> [<RetryAfter>]`              |

Reference table of numerics and the `METADATA` subcommands or any other commands that produce them:

| Label                   | GET | LIST | SET | CLEAR | SUB | UNSUB | SUBS | SYNC | Other   |
| ----------------------- | --- | ---- | --- | ----- | --- | ----- | ---- | ---- | ------- |
| `RPL_WHOISKEYVALUE`     |     |      |     |       |     |       |      |      | `WHOIS` |
| `RPL_KEYVALUE`          | \*  | \*   | \*  | \*    |     |       |      |      |         |
| `RPL_KEYNOTSET`         | \*  |      |     |       |     |       |      |      |         |
| `RPL_METADATASUBOK`     |     |      |     |       | \*  |       |      |      |         |
| `RPL_METADATAUNSUBOK`   |     |      |     |       |     | \*    |      |      |         |
| `RPL_METADATASUBS`      |     |      |     |       |     |       | \*   |      |         |
| `RPL_METADATASYNCLATER` |     |      |     |       | \*  |       |      | \*   | `JOIN`  |

Replies:

- `RPL_KEYVALUE` reports the values of metadata keys. The `Visibility` parameter is defined in the [server message](#metadata-server-message) section.

<a id="rpl_whoiskeyvalue-numeric"></a>

### `RPL_WHOISKEYVALUE` numeric [🔗](#rpl_whoiskeyvalue-numeric)

When a user with the capability enabled runs `WHOIS` on a user with metadata set, a subset of that metadata MAY be sent with `RPL_WHOISKEYVALUE` numerics.

<a id="examples-1"></a>

## Examples [🔗](#examples-1)

All examples begin with the client not being subscribed to any keys.

---

<a id="capability-examples"></a>

### Capability Examples [🔗](#capability-examples)

<a id="capability-value-in-cap-ls-1"></a>

#### Capability value in `CAP LS` 1 [🔗](#capability-value-in-cap-ls-1)

```
C: CAP LS 302
S: CAP * LS :userhost-in-names draft/metadata-2=foo,max-subs=50,bar multi-prefix
```

<a id="capability-value-in-cap-ls-2"></a>

#### Capability value in `CAP LS` 2 [🔗](#capability-value-in-cap-ls-2)

```
C: CAP LS 302
S: CAP * LS :draft/metadata-2=max-subs=25 multi-prefix invite-notify
```

---

<a id="metadata-command-examples"></a>

### METADATA command examples [🔗](#metadata-command-examples)

<a id="setting-metadata-on-self"></a>

#### Setting metadata on self [🔗](#setting-metadata-on-self)

```
C: METADATA * SET url :http://www.example.com
S: :irc.example.com 761 client * url * :http://www.example.com
```

<a id="setting-metadata-on-self-but-the-limit-has-been-reached"></a>

#### Setting metadata on self, but the limit has been reached [🔗](#setting-metadata-on-self-but-the-limit-has-been-reached)

```
C: METADATA * SET url :http://www.example.com
S: FAIL METADATA LIMIT_REACHED :Metadata limit reached
```

<a id="setting-metadata-on-another-user-without-permission"></a>

#### Setting metadata on another user, without permission [🔗](#setting-metadata-on-another-user-without-permission)

```
C: METADATA user1 SET url :http://www.example.com
S: FAIL METADATA KEY_NO_PERMISSION user1 url :You do not have permission to set 'url' on 'user1'
```

<a id="setting-metadata-on-channel"></a>

#### Setting metadata on channel [🔗](#setting-metadata-on-channel)

```
C: METADATA #example SET url :http://www.example.com
S: :irc.example.com 761 client #example url * :http://www.example.com
```

<a id="setting-metadata-on-an-invalid-target"></a>

#### Setting metadata on an invalid target [🔗](#setting-metadata-on-an-invalid-target)

```
C: METADATA $a:user SET url :http://www.example.com
S: FAIL METADATA INVALID_TARGET $a:user :Invalid target.
```

<a id="setting-metadata-with-an-invalid-key"></a>

#### Setting metadata with an invalid key [🔗](#setting-metadata-with-an-invalid-key)

```
C: METADATA user1 SET $url$ :http://www.example.com
S: FAIL METADATA KEY_INVALID $url$ :Invalid key.
```

<a id="server-rate-limits-setting-metadata-and-provides-a-retryafter-value"></a>

#### Server rate-limits setting metadata and provides a RetryAfter value [🔗](#server-rate-limits-setting-metadata-and-provides-a-retryafter-value)

```
C: METADATA * SET url :http://www.example.com
S: FAIL METADATA RATE_LIMITED * url 5 :Rate-limit reached. You're going too fast! Try again in 5 seconds.
```

<a id="server-rate-limits-setting-metadata-with-no-retryafter-value"></a>

#### Server rate-limits setting metadata with no RetryAfter value [🔗](#server-rate-limits-setting-metadata-with-no-retryafter-value)

```
C: METADATA * SET url :http://www.example.com
S: FAIL METADATA RATE_LIMITED * url * :Rate-limit reached. You're going too fast!
```

Thought: A non-normative retry value helps against automated spam while still being descriptive for the end-user.

---

<a id="metadata-message-examples"></a>

### METADATA message examples [🔗](#metadata-message-examples)

<a id="external-server-sets-metadata-on-a-user"></a>

#### External server sets metadata on a user [🔗](#external-server-sets-metadata-on-a-user)

```
S: :irc.example.com METADATA user1 account * :user1
```

<a id="user-sets-metadata-on-a-channel"></a>

#### User sets metadata on a channel [🔗](#user-sets-metadata-on-a-channel)

```
S: :user1!~user@somewhere.example.com METADATA #example url * :http://www.example.com
```

<a id="external-server-updates-metadata-on-a-channel"></a>

### External server updates metadata on a channel [🔗](#external-server-updates-metadata-on-a-channel)

```
S: :irc.example.com METADATA #example wiki-url * :http://wiki.example.com
```

---

<a id="listing-and-viewing-metadata-examples"></a>

### Listing and Viewing Metadata Examples [🔗](#listing-and-viewing-metadata-examples)

<a id="listing-metadata-with-an-implementation-defined-visibility-field"></a>

#### Listing metadata, with an implementation-defined visibility field [🔗](#listing-metadata-with-an-implementation-defined-visibility-field)

```
C: METADATA user1 LIST
S: :irc.example.com BATCH +VUN2ot metadata
S: @batch=VUN2ot :irc.example.com 761 client user1 url * :http://www.example.com
S: @batch=VUN2ot :irc.example.com 761 client user1 im.xmpp * :user1@xmpp.example.com
S: @batch=VUN2ot :irc.example.com 761 client user1 bot-likeliness-score visible-only-for-admin :42
S: :irc.example.com BATCH -VUN2ot
```

<a id="getting-several-metadata-keys-from-a-user"></a>

#### Getting several metadata keys from a user [🔗](#getting-several-metadata-keys-from-a-user)

```
C: METADATA user1 GET blargh splot im.xmpp
S: :irc.example.com BATCH +gWkCiV metadata
S: @batch=gWkCiV 766 client user1 blargh :No matching key
S: @batch=gWkCiV 766 client user1 splot :No matching key
S: @batch=gWkCiV :irc.example.com 761 client user1 im.xmpp * :user1@xmpp.example.com
S: :irc.example.com BATCH -gWkCiV
```

<a id="client-joins-a-channel-and-syncs-metadata-immediately"></a>

#### Client joins a channel and syncs metadata immediately [🔗](#client-joins-a-channel-and-syncs-metadata-immediately)

```
C: JOIN #smallchan
S: :modernclient!modernclient@example.com JOIN #smallchan
S: :irc.example.com 353 modernclient @ #smallchan :user1 user2 user3 user4 user5 ...
S: :irc.example.com 353 modernclient @ #smallchan :user51 user52 user53 user54 ...
S: :irc.example.com 353 modernclient @ #smallchan :user101 user102 user103 user104 ...
S: :irc.example.com 353 modernclient @ #smallchan :user151 user152 user153 user154 ...
S: :irc.example.com 366 modernclient #smallchan :End of /NAMES list.
S: :irc.example.com BATCH +UwZ67M metadata
S: @batch=UwZ67M :irc.example.com METADATA user2 bar * :second example value
S: @batch=UwZ67M :irc.example.com METADATA user1 foo * :third example value
S: @batch=UwZ67M :irc.example.com METADATA user1 bar * :this is another example value
S: @batch=UwZ67M :irc.example.com METADATA user3 website * :www.example.com
...and some more metadata messages
S: :irc.example.com BATCH -UwZ67M
```

<a id="client-joins-a-channel-and-but-needs-to-sync-metadata-later"></a>

#### Client joins a channel and but needs to sync metadata later [🔗](#client-joins-a-channel-and-but-needs-to-sync-metadata-later)

To-do: Think of a better sync-later flow

Client joins channel:

```
C: JOIN #bigchan
S: :modernclient!modernclient@example.com JOIN #bigchan
S: :irc.example.com 353 modernclient @ #bigchan :user1 user2 user3 user4 user5 ...
S: :irc.example.com 353 modernclient @ #bigchan :user51 user52 user53 user54 ...
S: :irc.example.com 353 modernclient @ #bigchan :user101 user102 user103 user104 ...
S: :irc.example.com 353 modernclient @ #bigchan :user151 user152 user153 user154 ...
S: :irc.example.com 366 modernclient #bigchan :End of /NAMES list.
S: :irc.example.com 774 modernclient #bigchan 4
```

Client waits 4 seconds:

```
C: METADATA #bigchan SYNC
S: :irc.example.com 774 modernclient #bigchan 6
```

Client waits 6 more seconds:

```
C: METADATA #bigchan SYNC
S: :irc.example.com BATCH +O5J6rk metadata
S: @batch=O5J6rk :irc.example.com METADATA user52 foo * :example value 1
S: @batch=O5J6rk :irc.example.com METADATA user2 bar * :second example value
S: @batch=O5J6rk :irc.example.com METADATA user1 foo * :third example value
S: @batch=O5J6rk :irc.example.com METADATA user1 bar * :this is another example value
S: @batch=O5J6rk :irc.example.com METADATA user152 baz * :Lorem ipsum
S: @batch=O5J6rk :irc.example.com METADATA user3 website * :www.example.com
S: @batch=O5J6rk :irc.example.com METADATA user152 bar * :dolor sit amet
...and many more metadata messages
S: :irc.example.com BATCH -O5J6rk
```

---

<a id="subscription-examples"></a>

### Subscription Examples [🔗](#subscription-examples)

<a id="basic-subscriping-and-unsubscribing"></a>

#### Basic subscriping and unsubscribing [🔗](#basic-subscriping-and-unsubscribing)

```
C: METADATA * SUB avatar website foo bar
S: :irc.example.com 770 modernclient avatar website foo bar
C: METADATA * UNSUB foo bar
S: :irc.example.com 771 modernclient bar foo
```

<a id="multiple-rpl_metadatasubok-numerics-in-reply-to-metadata-sub"></a>

#### Multiple `RPL_METADATASUBOK` numerics in reply to `METADATA SUB` [🔗](#multiple-rpl_metadatasubok-numerics-in-reply-to-metadata-sub)

```
C: METADATA * SUB avatar website foo bar baz
S: :irc.example.com 770 modernclient avatar website
S: :irc.example.com 770 modernclient foo
S: :irc.example.com 770 modernclient bar baz
```

<a id="invalid-key-name-in-reply-to-subscription"></a>

#### Invalid key name in reply to subscription [🔗](#invalid-key-name-in-reply-to-subscription)

```
C: METADATA * SUB foo $url bar
S: :irc.example.com 770 modernclient foo bar
S: FAIL METADATA KEY_INVALID $url :Invalid key
```

<a id="subscribed-to-too-many-keys-error-in-reply-to-subscription-1"></a>

#### “Subscribed to too many keys” error in reply to subscription 1 [🔗](#subscribed-to-too-many-keys-error-in-reply-to-subscription-1)

The client first successfully subscribes to some keys and later it tries to subscribe to some more keys, unsuccessfully.

```
C: METADATA * SUB website avatar foo bar baz
S: :irc.example.com 770 modernclient website avatar foo bar baz
C: METADATA * SUB email city
S: FAIL METADATA TOO_MANY_SUBS email :Too many subscriptions!
C: METADATA * SUBS
S: :irc.example.com 770 modernclient website avatar foo bar baz
```

<a id="subscribed-to-too-many-keys-error-in-reply-to-subscription-2"></a>

#### “Subscribed to too many keys” error in reply to subscription 2 [🔗](#subscribed-to-too-many-keys-error-in-reply-to-subscription-2)

This is like the previous case, except when the second METADATA SUB happens the server accepts the first 2 keys (`email`, `city`) but not the rest (`country`, `bar`, `baz`).

```
C: METADATA * SUB website avatar foo
S: :irc.example.com 770 modernclient website avatar foo
C: METADATA * SUB email city country bar baz
S: FAIL METADATA TOO_MANY_SUBS country :Too many subscriptions!
S: :irc.example.com 770 modernclient email city
C: METADATA * SUBS
S: :irc.example.com 770 modernclient website avatar city foo email
```

<a id="subscribed-to-too-many-keys-error-in-reply-to-subscription-3"></a>

#### “Subscribed to too many keys” error in reply to subscription 3 [🔗](#subscribed-to-too-many-keys-error-in-reply-to-subscription-3)

In this case, the client is trying to subscribe to a key that it is already subscribed to (`website`), but the key is not processed because the limit imposed by the server on the number of subscribed keys is reached before the `website` key is processed by the server. The client, however, successfully subscribes to the `foo` key which was also in the second request, but it appeared before the `website` key.

```
C: METADATA * SUB avatar website
S: :irc.example.com 770 modernclient avatar website
C: METADATA * SUB foo website avatar
S: FAIL METADATA TOO_MANY_SUBS website :Too many subscriptions!
S: :irc.example.com 770 modernclient :foo
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar foo website
```

<a id="querying-the-list-of-subscribed-keys-1"></a>

#### Querying the list of subscribed keys 1 [🔗](#querying-the-list-of-subscribed-keys-1)

The server replies with a single `RPL_METADATASUBS` (`772`) numeric.

```
C: METADATA * SUB website avatar foo bar baz
S: :irc.example.com 770 modernclient website avatar foo bar baz
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar bar baz foo website
```

<a id="querying-the-list-of-subscribed-keys-2"></a>

#### Querying the list of subscribed keys 2 [🔗](#querying-the-list-of-subscribed-keys-2)

The server replies with multiple `RPL_METADATASUBS` (`772`) numerics.

```
C: METADATA * SUB website avatar foo bar baz
S: :irc.example.com 770 modernclient website avatar foo bar baz
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar
S: :irc.example.com 772 modernclient bar baz
S: :irc.example.com 772 modernclient foo website
```

<a id="empty-list-of-subscribed-keys"></a>

#### Empty list of subscribed keys [🔗](#empty-list-of-subscribed-keys)

In this case, there are no `RPL_METADATASUB` numerics sent.

```
C: METADATA * SUBS
S: *no replies*
```

<a id="unsubscribing"></a>

#### Unsubscribing [🔗](#unsubscribing)

```
C: METADATA * SUB website avatar foo bar baz
S: :irc.example.com 770 modernclient website avatar foo bar baz
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar bar baz foo website
C: METADATA * UNSUB bar foo baz
S: :irc.example.com 771 modernclient baz foo bar
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar website
```

<a id="subscribing-to-the-same-key-multiple-times-1"></a>

#### Subscribing to the same key multiple times 1 [🔗](#subscribing-to-the-same-key-multiple-times-1)

```
C: METADATA * SUB website avatar foo bar baz
S: :irc.example.com 779 modernclient website avatar foo bar baz
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar bar baz foo website
C: METADATA * SUB avatar website
S: :irc.example.com 770 modernclient avatar website
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar bar baz foo website
```

<a id="subscribing-to-the-same-key-multiple-times-2"></a>

#### Subscribing to the same key multiple times 2 [🔗](#subscribing-to-the-same-key-multiple-times-2)

The client (erroneously) subscribes to the same key twice in the same command. The server is free to include the key being subscribed to in the `RPL_METADATASUBOK` (`770`) numeric once or twice.

In both cases, the key will only appear once in the reply to a following `METADATA SUBS` command.

Once:

```
C: METADATA * SUB avatar avatar
S: :irc.example.com 770 modernclient avatar
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar
```

Twice:

```
C: METADATA * SUB avatar avatar
S: :irc.example.com 770 modernclient avatar avatar
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar
```

<a id="unsubscribing-from-a-non-subscribed-key-1"></a>

#### Unsubscribing from a non-subscribed key 1 [🔗](#unsubscribing-from-a-non-subscribed-key-1)

```
C: METADATA * SUBS
C: METADATA * UNSUB website
S: :irc.example.com 771 modernclient website
C: METADATA * SUBS
C: METADATA * SUB website
S: :irc.example.com 771 modernclient website
C: METADATA * SUBS
S: :irc.example.com 772 modernclient website
```

<a id="unsubscribing-from-a-non-subscribed-key-2"></a>

#### Unsubscribing from a non-subscribed key 2 [🔗](#unsubscribing-from-a-non-subscribed-key-2)

The client (erroneously) unsubscribes from the same key twice in the same command. The server is free to include the key being unsubscribed from in the `RPL_METADATAUNSUBOK` numeric once or twice.

Once:

```
C: METADATA * SUBS
S: :irc.example.com 772 modernclient website
C: METADATA * UNSUB website website
S: :irc.example.com 772 modernclient website
```

Twice:

```
C: METADATA * SUBS
S: :irc.example.com 772 modernclient website
C: METADATA * UNSUB website website
S: :irc.example.com 771 modernclient website website
```

<a id="subscribing-to-a-key-which-requires-privileges-but-without-privileges"></a>

#### Subscribing to a key which requires privileges but without privileges [🔗](#subscribing-to-a-key-which-requires-privileges-but-without-privileges)

```
C: METADATA * SUB avatar secretkey website
S: FAIL METADATA KEY_NO_PERMISSION modernclient secretkey :You do not have permission to do that.
S: :irc.example.com 770 modernclient avatar website
C: METADATA * SUBS
S: :irc.example.com 772 modernclient avatar website
```

<a id="subscribing-to-invalid-keys-and-a-key-which-requires-privileges-but-without-privileges"></a>

#### Subscribing to invalid keys and a key which requires privileges but without privileges [🔗](#subscribing-to-invalid-keys-and-a-key-which-requires-privileges-but-without-privileges)

```
C: METADATA * SUB $invalid1 secretkey1 $invalid2 secretkey2 website
S: FAIL METADATA KEY_NO_PERMISSION modernclient secretkey1 :You do not have permission to do that.
S: FAIL METADATA KEY_INVALID $invalid1 :Invalid key
S: FAIL METADATA KEY_NO_PERMISSION modernclient secretkey2 :You do not have permission to do that.
S: FAIL METADATA KEY_INVALID $invalid2 :Invalid key
S: :irc.example.com 770 modernclient website
C: METADATA * SUBS
S: :irc.example.com 772 modernclient website
```

---

<a id="setting-keys-and-subscribing-with-before-connect"></a>

### Setting keys and subscribing with `before-connect` [🔗](#setting-keys-and-subscribing-with-before-connect)

```
C: CAP LS 302
S: :metadata.test CAP * LS :batch message-tags draft/metadata-2=before-connect,max-subs=100,max-keys=100
C: CAP REQ :batch message-tags draft/metadata-2
S: :metadata.test CAP * ACK :batch message-tags draft/metadata-2
C: METADATA * SUB display-name
S: :metadata.test 770 * display-name
C: METADATA * SET display-name :a b c
S: :metadata.test 761 * * display-name * :a b c
C: NICK abc
C: USER u s e r
C: CAP END
S: :metadata.test 001 abc :Welcome to the MetadataTesting IRC Network abc
S: [redacted registration burst messages]
S: :metadata.test BATCH +1 metadata
S: @batch=1 :metadata.test METADATA abc display-name * :a b c
S: :metadata.test BATCH -1
S: [redacted registration burst messages]
S: :metadata.test 376 abc :End of MOTD command
C: METADATA * LIST
S: :metadata.test BATCH +2 metadata
S: @batch=2 :metadata.test 761 abc abc display-name * :a b c
S: :metadata.test BATCH -2
C: METADATA * SUBS
S: :metadata.test BATCH +3 metadata-subs
S: @batch=3 :metadata.test 772 abc display-name
S: :metadata.test BATCH -3
```

---

<a id="non-normative-examples"></a>

### Non-normative examples [🔗](#non-normative-examples)

The following examples describe how an implementation might use certain features. Unlike previous examples, they are in no way intended to guide implementations’ behaviour.

<a id="notification-for-a-user-becoming-an-operator"></a>

#### Notification for a user becoming an operator: [🔗](#notification-for-a-user-becoming-an-operator)

```
:OperServ!OperServ@services.int METADATA user1 services.operclass oper:auspex :services-root
```

<a id="client-implementation-considerations"></a>

### Client implementation considerations [🔗](#client-implementation-considerations)

_This section is not normative_

While this is true of any batch, clients should take particular care not to pause processing of other messages while a `metadata` batch is open. As these batches can be potentially large, servers are likely to produce them asynchronously in order to avoid freezing delivery of more important messages.

As servers may rewrite values set by clients with `METADATA SET`, clients should check the response before storing it in any local cache.

<a id="differences-between-this-specification-and-metadata-notify"></a>

### Differences between this specification and `metadata-notify` [🔗](#differences-between-this-specification-and-metadata-notify)

_This section is not normative_

This specification replaces an earlier deprecated `metadata-notify` specification, by adding the following incompatible changes:

- The `metadata-notify` cap subscribed you to all keys. With the addition of explicit [`SUB`](#metadata-sub) and [`UNSUB`](#metadata-unsub) subcommands, this is no longer the case.
- Rate limiting protocol mechanics.
- Support for delayed synchronization and `METADATA SYNC`.
- Moved `ERR_*` replies to Standard Replies format
- The `RPL_KEYNOTSET(766)` numeric replaces the `ERR_NOMATCHINGKEY` numeric in previous versions. It is no longer an error response and has a different meaning. For the error response see the `KEY_NOT_SET` standard reply.
- The numerics `RPL_METADATASUBOK(770)`, `RPL_METADATAUNSUBOK(771)`, `RPL_METADATASUBS(772)` changed from using a space separated final parameter `:<Key1> [<Key2> ...]` to a list of individual parameters `<Key1> [<Key2> ...]`.
- Use of batch instead of `RPL_METADATAEND` in situations where more than one `RPL_KEYVALUE` is sent.
- Non-standard keys should now use a vendor prefix

<a id="errata"></a>

## Errata [🔗](#errata)

- A previous version of this specification sent `RPL_KEYVALUE` as the response to `METADATA CLEAR`. This was changed to `RPL_KEYNOTSET` to simplify client processsing.

---

Software supporting Metadata: [Ergo](https://ergo.chat/), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [Mango](https://mangoirc.chat), [IRCCloud](https://www.irccloud.com), [Tubes](https://tubes.pronounmail.com), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma), [soju (as Server)](https://codeberg.org/emersion/soju)
