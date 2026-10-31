> Source: https://ircv3.net/irc/ Captured: 2026-10-26

IRCv3 specifications build on top of the core IRC protocol. The primary core is described by the [“Modern IRC” specification](../modern/client-protocol.md), which supersedes historical IRC protocol specifications ([`RFC1459`](https://tools.ietf.org/html/rfc1459), [`RFC2812`](https://tools.ietf.org/html/rfc2812) and [`RFC7194`](https://tools.ietf.org/html/rfc7194)). To fully understand IRCv3, please read the “Modern IRC” specification followed by the IRCv3 specifications.

The IRCv3 specifications are released when they are stable and have been widely tested. [In the past](http://web.archive.org/web/20160402092520/https://ircv3.net/irc/) the WG released specifications as versioned bundles (IRCv3.1, IRCv3.2), but we no longer do this.

Errata updates may be submitted for our specifications. To do so, simply see our [contribution](https://github.com/ircv3/ircv3-specifications/blob/master/CONTRIBUTING.md) document.

---

<a id="capability-negotiation"></a>

## Capability Negotiation [🔗](#capability-negotiation)

Capabilities let us implement protocol changes in backwards-compatible ways. They also convey various information on joining a server. Capability negotiation is a vital part of IRCv3, and lets clients request and enable the CAPs they support once they’ve joined a server.

The [Capability Negotiation spec](specs/extensions/capability-negotiation.md) conveys the basic listing and requesting of capabilities, and lays the framework which most IRCv3 specs use. It also goes over the `302` extensions, and [`cap-notify`](specs/extensions/capability-negotiation.md#cap-notify) – a feature to let clients know when capabilities are added to or removed from the server (for example, if the SASL authentication layer disconnects, the associated capability may be disabled for a time).

<a id="message-tags"></a>

## [Message Tags](specs/extensions/message-tags.md) [🔗](#message-tags)

Message tags extend the core framing used with IRC messages, and allow extended data to be sent with messages.

Message tags are widely used in the IRCv3 specifications. As such, most software implementing IRCv3 extensions will want to to implement the core Message Tags specification.

The [Message Tags spec](specs/extensions/message-tags.md) covers the new message format, how tag data is formatted and escaped, and how they are named. In addition, it extends the message length and lets clients send tags directly between each other, allowing new features to be developed and implemented independently from the IRC servers themselves (similar to extensions based on CTCP).

**Note:** Message tags themselves are used as a foundation for other extensions and do not themselves offer any user-facing features. Specific message tags are defined in the various IRCv3 specifications.

<a id="account-authentication-and-registration"></a>

## Account Authentication and Registration [🔗](#account-authentication-and-registration)

Accounts have become a first-class feature on IRC. They store channel access and ownership information, preferences, settings, nickname ownership, and even more. Our extensions describe simple account creation and authentication.

The **work-in-progress** [Account Registration spec](specs/extensions/account-registration.md) lets clients build nice account registration interfaces, instead of making users manually send messages to service bots.

SASL lets users authenticate in a standardised way across different IRC networks. It gives a way to authenticate while connecting, without having to message service bots after they’ve joined the server. Because SASL allows authentication before they’ve finished connecting, it lets clients join private and restricted channels without having to setup complex join-wait systems.

The [v3.1 SASL spec](specs/extensions/sasl-3.1.md) defines the `AUTHENTICATE` command and `sasl` cap, which work together to allow clients to authenticate to the network.

The [v3.2 SASL spec](specs/extensions/sasl-3.2.md) defines a way to advertise the authentication methods available to clients, allows for clients to re-authenticate after services is lost and reconnects, and defines what to do if the authentication layer is disconnected or reconnected.

IRC SASL authentication primarily uses the same mechanisms as SASL in other protocols. Most commonly:

- [PLAIN](https://tools.ietf.org/html/rfc4616) as defined by RFC 4616
- [EXTERNAL](https://tools.ietf.org/html/rfc4422#appendix-A) as defined by RFC 4422
- [SCRAM-SHA-256](https://tools.ietf.org/html/rfc7677) as defined by RFC 7677

For further information on SASL mechanism support, see the [SASL Mechanisms page](docs/sasl-mechs.md).

---

<a id="account-tracking"></a>

## Account Tracking [🔗](#account-tracking)

IRCv3 extensions allow clients to much more easily know when other users are logged into accounts. This allows for much greater integration between client bots and the network’s authentication system, as well as better general display and authentication of client identities.

The [`account-extban` spec](specs/extensions/account-extban.md) defines an ISUPPORT token allowing clients to construct an EXTBAN targeting a specific user account, e.g. to prevent them from joining a channel, make it exempt from bans, or permanently allow it to an invite-only channel.

The [`account-notify` spec](specs/extensions/account-notify.md) defines a way for clients to be notified when other clients login to accounts. This spec defines the `ACCOUNT` message to enable this, use of the `a` WHOX token, as well as outlining the general restriction of account names not being `*` (as this is used to indicate logging out of accounts).

The [`account-tag` spec](specs/extensions/account-tag.md) defines a way for clients to receive a message tag on messages specifying the current account that other client is logged into (or that they aren’t logged into one at all). This is especially useful for letting bots make use of the network’s authentication and account mechanisms.

The [`extended-join` spec](specs/extensions/extended-join.md) defines a way to request that extra client information (including that client’s account) is sent when clients join a given channel. This allows better tracking of accounts, particularly when used with `account-notify`.

<a id="away-notifications"></a>

## [Away Notifications](specs/extensions/away-notify.md) [🔗](#away-notifications)

The `away-notify` extension provides a way for clients to instantly know when other clients go away or come back. This improves responsiveness and the display of channels for IRC clients that display this information.

The [`away-notify` spec](specs/extensions/away-notify.md) describes how to sign up for these notifications and the `AWAY` message to enable this.

<a id="batches"></a>

## [Batches](specs/extensions/batch.md) [🔗](#batches)

The `batch` extension provides a way for servers to mark certain messages as related. This can simplify the display of this information in clients as well as allow better post-processing on them.

The [`batch` spec](specs/extensions/batch.md) describes the naming of new batch types, the semantics of batches and how clients should process them.

The **work-in-progress** [client initiated batch extension](specs/extensions/client-batch.md) describes client-to-server batches.

**Note:** Batches themselves are used as a foundation for other extensions and do not themselves offer any user-facing features.

Here are the standalone batch types the IRCv3 WG defines:

- [The `netsplit` and `netjoin` batch types](specs/batches/netsplit.md) allow clients to collapse netsplits and netjoins more effectively.
- [The `chathistory` batch type](specs/batches/chathistory.md) allows replaying message history.

<a id="bot-mode"></a>

## [Bot Mode](specs/extensions/bot-mode.md) [🔗](#bot-mode)

The Bot mode lets bots mark themselves as such. Other users will see the client as a bot in various ways, and should see a tag on that client’s messages if they have requested the `message-tags` capability.

The [Bot Mode spec](specs/extensions/bot-mode.md) describes the mode and how to see bots that have set the mode on themselves.

<a id="channel-renaming"></a>

## [Channel renaming](specs/extensions/channel-rename.md) [🔗](#channel-renaming)

The `channel-rename` extension adds a new command sent by clients and servers that enables renaming a channel without closing it down and redirecting to a new one.

The **work-in-progress** [`channel-rename` spec](specs/extensions/channel-rename.md) describes how to use the `RENAME` command to achieve this.

<a id="persistence"></a>

## Persistence [🔗](#persistence)

The **work-in-progress** [`chathistory` spec](specs/extensions/chathistory.md) describes the syntax and semantics of the new `CHATHISTORY` command, which standardizes a mechanism for clients to request message history from servers or bouncers.

The **work-in-progress** [`message-redaction` spec](specs/extensions/message-redaction.md) adds a new command to remove a message from the history, and indicate to other clients they should hide it.

The **work-in-progress** [`read-marker` spec](specs/extensions/read-marker.md) adds a new command to synchronize read markers between several clients of the same user.

The **work-in-progress** [`pre-away` spec](specs/extensions/pre-away.md) allows clients to send `AWAY` commands during connection registration.

<a id="changing-user-properties"></a>

## Changing User Properties [🔗](#changing-user-properties)

Several extensions allow servers to notify clients of properties of other users that were historically considered nonchanging for the lifetime of a connection.

The [`chghost` spec](specs/extensions/chghost.md) describes the new `CHGHOST` message which lets clients more easily see when other clients’ usernames and/or hostnames are changed. This replaces the clunky method of sending a fake `QUIT`, and then one or more fake `JOIN` messages instead.

The [`setname` spec](specs/extensions/setname.md) describes the new `SETNAME` message which allows clients to update their realname (gecos) after connecting to the server, and see updates from other users. This is especially useful as some clients use the realname information for avatars and an additional name field.

<a id="client-only-tags"></a>

## Client-Only Tags [🔗](#client-only-tags)

Client-only tags are message tags that are sent directly between clients with no server involvement. They’re special in IRCv3 as they only apply to clients, and as such we detail them in their own section here.

Here are the client-only tags the IRCv3 WG defines:

- [The `channel-context` client-only tag](specs/client-tags/channel-context.md) indicates the channel a private message should be displayed in.
- [The `reply` client-only tag](specs/client-tags/reply.md) marks that a given message is intended as a reply to a specific sent message.
- [The `react` client-only tag](specs/client-tags/react.md) **\[draft\]** sends a reaction to a specific sent message, allowing such functionality from other chat systems.
- [The `typing` client-only tag](specs/client-tags/typing.md) lets users know when another user is typing a message in their channel or private message.

<a id="echo-message"></a>

## [Echo Message](specs/extensions/echo-message.md) [🔗](#echo-message)

The `echo-message` extension lets clients confirm when messages are sent, and see messages that other clients on their connection (say, via an IRC bouncer) have sent. It does this by echoing messages back to clients after they are sent, allowing for these extra features.

The [`echo-message` spec](specs/extensions/echo-message.md) describes which messages are echo’d, and how they are interpreted by clients.

<a id="invite-notify"></a>

## [Invite Notify](specs/extensions/invite-notify.md) [🔗](#invite-notify)

The `invite-notify` extension allows privileged channel users to see when someone is invited to their channel. This can help chanops better run their channels and see better information about what’s going on.

The [`invite-notify` spec](specs/extensions/invite-notify.md) describes the new `INVITE` reply which this extension uses, and how clients interpret these notifications.

<a id="isupport"></a>

## `ISUPPORT` [🔗](#isupport)

The **work-in-progress** [`extended-isupport` spec](specs/extensions/extended-isupport.md) allows clients to fetch the `ISUPPORT` metadata prior to connection registration, introduces a new command to fetch `ISUPPORT` and a new batch type to delimit `ISUPPORT` bursts.

The **work-in-progress** [network icon spec](specs/extensions/network-icon.md) introduces a new `ISUPPORT` token to advertise a network icon.

<a id="labeled-responses"></a>

## [Labeled Responses](specs/extensions/labeled-response.md) [🔗](#labeled-responses)

The `labeled-response` extension allows clients to link returned numerics with sent commands. This allows for much richer/accurate implementations of `echo-message`, and lets clients generally corrolate sent and received messages.

Additionally, this should also assist bouncers with correctly directing responses to the right connected client.

The [`labeled-response` spec](specs/extensions/labeled-response.md) covers the `label` tag, and how clients should send and will receive labels.

<a id="listing-users"></a>

## Listing Users [🔗](#listing-users)

IRCv3 specifications extend traditional queries (`NAMES`, `WHOIS`, `WHO`) to carry more information about other users in a given channel.

The [`multi-prefix` spec](specs/extensions/multi-prefix.md) details changes to these queries, which allow clients to see all the statuses (i.e. voice, chanop) that other clients have in a channel rather than just the highest. This improves data tracking for clients and bots, and allows clients to display the privilege level of other clients more correctly.

The [`userhost-in-names` spec](specs/extensions/userhost-in-names.md) describes how the `NAMES` message changes with this capability active, and how clients should interpret the changes. This allows clients to more easily see the user/hostnames of other clients when joining channels. This allows clients to better track info and automate client features more easily.

The [`WHOX` spec](specs/extensions/whox.md) describes how the `WHO` message and its replies changes with this capability active to allow clients to request more data, and how clients should interpret these changes.

The [`no-implicit-names` spec](specs/extensions/no-implicit-names.md) allows clients to disable the implicit `NAMES` responses sent after `JOIN` in case they don’t always need that information for all channels. Clients can still query that information as needed via the `NAMES` or `WHO` command.

The **work-in-progress** [`oper-tag` spec](specs/extensions/oper-tag.md) defines a way for clients to receive a message tag on messages specifying that the source of the message is from an IRC operator. This is useful for letting users know that a message is from a trusted source.

<a id="message-ids"></a>

## [Message IDs](specs/extensions/message-ids.md) [🔗](#message-ids)

The `message-ids` extension allows servers to provide a network-unique identifier on messages (including `PRIVMSG`/`NOTICE`). This allows clients to build new features that refer to specific messages, with the knowledge that these identifiers will be unique.

The [`message-ids` spec](specs/extensions/message-ids.md) covers the `msgid` tag, how servers should generate message IDs and how clients should treat them.

**Note:** Message IDs themselves are used as a foundation for other extensions and do not themselves offer any user-facing features. Specific IRCv3 extensions will note their use of (and dependency on) message IDs.

<a id="metadata"></a>

## [Metadata](specs/extensions/metadata.md) [🔗](#metadata)

The **work-in-progress** [`metadata-2`](specs/extensions/metadata.md) specification is a framework to associate information to users. It succeeds the v3.2 `METADATA` command, which was found to have issues related to rate-limiting and excessive notifications, which made it impossible for servers in widespread use to implement.

<a id="monitor"></a>

## [Monitor](specs/extensions/monitor.md) [🔗](#monitor)

The `MONITOR` command acts as a standardized way for clients to be alerted when other clients enter or exit the network. This is in opposition to `ISON`, which does this through polling, and `WATCH`, which differs between vendor implementations.

The [Monitor spec](specs/extensions/monitor.md) details this command, the relevant `RPL_ISUPPORT` token and the commands used with it.

The [Extended Monitor spec](specs/extensions/extended-monitor.md) builds upon the Monitor spec, and extends it to various events.

<a id="multiline-messages"></a>

## [Multiline messages](specs/extensions/multiline.md) [🔗](#multiline-messages)

The `multiline` extension adds a new batch type and tag sent by clients and servers to send messages that can exceed the usual byte length limit and that can contain line breaks.

The **work-in-progress** [`multiline` spec](specs/extensions/multiline.md) describes how to use the `draft/multiline` batch type and `draft/multiline-concat` tag to achieve this.

<a id="server-time"></a>

## [Server Time](specs/extensions/server-time.md) [🔗](#server-time)

The `server-time` extension allows clients to see the exact time that messages were sent and received. This allows bouncers to replay information with more accurate time tracking.

The [`server-time` spec](specs/extensions/server-time.md) describes the `time` tag, how to specify timestamps and how clients should parse incoming timestamps.

<a id="server-name-indication-sni"></a>

## [Server Name Indication (SNI)](docs/sni.md) [🔗](#server-name-indication-sni)

SNI makes it easier for servers to send the correct TLS certificate to connecting clients.

The **work-in-progress** [SNI spec](docs/sni.md) provides guidelines for clients and servers, allowing them to better detect the TLS certificate to send based on the server’s hostname.

<a id="standard-replies"></a>

## [Standard Replies](specs/extensions/standard-replies.md) [🔗](#standard-replies)

Standard Replies establishes a clean way to send notes, warnings, and errors to users. This helps server/bouncer developers avoid creating new (possibly conflicting) numerics, and ensures clients will be able to display these messages to users nicely.

The [standard replies spec](specs/extensions/standard-replies.md) describes the format of these messages, how to use them, and guidance on creating useful descriptions for users.

<a id="strict-transport-security-sts"></a>

## [Strict Transport Security (STS)](specs/extensions/sts.md) [🔗](#strict-transport-security-sts)

STS allows clients to be automatically upgraded to use TLS encryption and prevents downgrade attacks. STS is intended as a replacement for the `STARTTLS` command with better security qualities.

The [`sts` spec](specs/extensions/sts.md) describes the `sts` capability, how it operates, and various implementation details for both clients and servers.

<a id="utf8only"></a>

## [UTF8ONLY](specs/extensions/utf8-only.md) [🔗](#utf8only)

The `UTF8ONLY` ISUPPORT token lets servers indicate that they only support UTF-8 traffic, allowing clients to set their incoming/outgoing encodings automatically.

The [`UTF8ONLY` spec](specs/extensions/utf8-only.md) details the `RPL_ISUPPORT` token, associated messages, and functionality.

<a id="webirc"></a>

## [WebIRC](specs/extensions/webirc.md) [🔗](#webirc)

The `WEBIRC` command is widely used to provide the real IP address of users to the server when connecting through a gateway. This is common for current web-based IRC clients.

The [`WEBIRC` spec](specs/extensions/webirc.md) describes how this command works, how to use it, and some best practices to keep in mind while implementing this feature.

<a id="websocket"></a>

## [WebSocket](specs/extensions/websocket.md) [🔗](#websocket)

The [WebSocket spec](specs/extensions/websocket.md) describes conventions for transporting IRC lines over the WebSocket protocol. This is necessary for browser-based clients, which cannot make conventional TCP connections to IRC servers.

---

<a id="deprecated-extensions"></a>

# Deprecated Extensions [🔗](#deprecated-extensions)

These extensions have been explicitly **deprecated**. We no longer recommend implementing them. Generally, these extensions have either been superseded, or other major implementation issues have been discovered with them.

<a id="starttls"></a>

## [STARTTLS](specs/deprecated/tls.md) [🔗](#starttls)

STARTTLS allows clients to upgrade their plaintext connections to use TLS encryption. In alignment with [RFC8314](https://tools.ietf.org/html/rfc8314), it is recommended that IRC networks use listeners designed for implicit TLS (such as those that operate on port 6697) and clients instead implement STS support.

The [`tls` spec](specs/deprecated/tls.md) is still available for reference. It describes how the `STARTTLS` command works, as well as how connection registration is changed by the introduction of this capability.
