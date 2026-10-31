# IRC documentation

| Capture   | Value                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| Date      | 2026-10-26                                                                    |
| Format    | Markdown                                                                      |
| Documents | 53: two Modern IRC documents, IRCv3 index, 48 specs, two supporting documents |
| Tools     | `ax` link discovery; `crw --raw --css` extraction                             |

- Document text retains upstream wording, copyright notices, and specification status.
- Links between captured pages resolve locally; other links resolve to their source websites.
- The client protocol retains five upstream links to missing section anchors.
- Explicit HTML anchors preserve source section links in Markdown renderers that support HTML.
- Markdown preserves text and code; CSS colors and other visual styling require the source website.

## Which documents are included?

| Document | Local Markdown | Source |
| --- | --- | --- |
| Modern IRC Client Protocol | [Open](modern/client-protocol.md) | [Original](https://modern.ircdocs.horse/) |
| IRC Formatting | [Open](modern/formatting.md) | [Original](https://modern.ircdocs.horse/formatting) |
| IRCv3 Specifications | [Open](ircv3/index.md) | [Original](https://ircv3.net/irc/) |
| SASL Mechanisms | [Open](ircv3/docs/sasl-mechs.md) | [Original](https://ircv3.net/docs/sasl-mechs) |
| Client Capability Negotiation | [Open](ircv3/specs/extensions/capability-negotiation.md) | [Original](https://ircv3.net/specs/extensions/capability-negotiation) |
| Message Tags | [Open](ircv3/specs/extensions/message-tags.md) | [Original](https://ircv3.net/specs/extensions/message-tags) |
| `account-registration` Extension | [Open](ircv3/specs/extensions/account-registration.md) | [Original](https://ircv3.net/specs/extensions/account-registration) |
| IRCv3.1 SASL Authentication | [Open](ircv3/specs/extensions/sasl-3.1.md) | [Original](https://ircv3.net/specs/extensions/sasl-3.1) |
| IRCv3.2 SASL Authentication | [Open](ircv3/specs/extensions/sasl-3.2.md) | [Original](https://ircv3.net/specs/extensions/sasl-3.2) |
| Account Extended Ban | [Open](ircv3/specs/extensions/account-extban.md) | [Original](https://ircv3.net/specs/extensions/account-extban) |
| `account-notify` Extension | [Open](ircv3/specs/extensions/account-notify.md) | [Original](https://ircv3.net/specs/extensions/account-notify) |
| `account-tag` Extension | [Open](ircv3/specs/extensions/account-tag.md) | [Original](https://ircv3.net/specs/extensions/account-tag) |
| `extended-join` Extension | [Open](ircv3/specs/extensions/extended-join.md) | [Original](https://ircv3.net/specs/extensions/extended-join) |
| `away-notify` Extension | [Open](ircv3/specs/extensions/away-notify.md) | [Original](https://ircv3.net/specs/extensions/away-notify) |
| `batch` Extension | [Open](ircv3/specs/extensions/batch.md) | [Original](https://ircv3.net/specs/extensions/batch) |
| Client initiated batch Extension | [Open](ircv3/specs/extensions/client-batch.md) | [Original](https://ircv3.net/specs/extensions/client-batch) |
| `netsplit` and `netjoin` Batch Types | [Open](ircv3/specs/batches/netsplit.md) | [Original](https://ircv3.net/specs/batches/netsplit) |
| `chathistory` Batch Type | [Open](ircv3/specs/batches/chathistory.md) | [Original](https://ircv3.net/specs/batches/chathistory) |
| Bot Mode | [Open](ircv3/specs/extensions/bot-mode.md) | [Original](https://ircv3.net/specs/extensions/bot-mode) |
| Channel Renaming | [Open](ircv3/specs/extensions/channel-rename.md) | [Original](https://ircv3.net/specs/extensions/channel-rename) |
| `chathistory` Extension | [Open](ircv3/specs/extensions/chathistory.md) | [Original](https://ircv3.net/specs/extensions/chathistory) |
| Message redaction | [Open](ircv3/specs/extensions/message-redaction.md) | [Original](https://ircv3.net/specs/extensions/message-redaction) |
| Read marker | [Open](ircv3/specs/extensions/read-marker.md) | [Original](https://ircv3.net/specs/extensions/read-marker) |
| `pre-away` Extension | [Open](ircv3/specs/extensions/pre-away.md) | [Original](https://ircv3.net/specs/extensions/pre-away) |
| `chghost` Extension | [Open](ircv3/specs/extensions/chghost.md) | [Original](https://ircv3.net/specs/extensions/chghost) |
| `setname` Extension | [Open](ircv3/specs/extensions/setname.md) | [Original](https://ircv3.net/specs/extensions/setname) |
| `channel-context` client tag | [Open](ircv3/specs/client-tags/channel-context.md) | [Original](https://ircv3.net/specs/client-tags/channel-context) |
| `reply` client tag | [Open](ircv3/specs/client-tags/reply.md) | [Original](https://ircv3.net/specs/client-tags/reply) |
| `react` client tag | [Open](ircv3/specs/client-tags/react.md) | [Original](https://ircv3.net/specs/client-tags/react) |
| `typing` client tag | [Open](ircv3/specs/client-tags/typing.md) | [Original](https://ircv3.net/specs/client-tags/typing) |
| `echo-message` Extension | [Open](ircv3/specs/extensions/echo-message.md) | [Original](https://ircv3.net/specs/extensions/echo-message) |
| `invite-notify` Extension | [Open](ircv3/specs/extensions/invite-notify.md) | [Original](https://ircv3.net/specs/extensions/invite-notify) |
| `extended-isupport` Extension | [Open](ircv3/specs/extensions/extended-isupport.md) | [Original](https://ircv3.net/specs/extensions/extended-isupport) |
| Network Icon | [Open](ircv3/specs/extensions/network-icon.md) | [Original](https://ircv3.net/specs/extensions/network-icon) |
| Labeled Responses | [Open](ircv3/specs/extensions/labeled-response.md) | [Original](https://ircv3.net/specs/extensions/labeled-response) |
| `multi-prefix` Extension | [Open](ircv3/specs/extensions/multi-prefix.md) | [Original](https://ircv3.net/specs/extensions/multi-prefix) |
| `userhost-in-names` Extension | [Open](ircv3/specs/extensions/userhost-in-names.md) | [Original](https://ircv3.net/specs/extensions/userhost-in-names) |
| WHOX | [Open](ircv3/specs/extensions/whox.md) | [Original](https://ircv3.net/specs/extensions/whox) |
| `no-implicit-names` Extension | [Open](ircv3/specs/extensions/no-implicit-names.md) | [Original](https://ircv3.net/specs/extensions/no-implicit-names) |
| `oper-tag` Extension | [Open](ircv3/specs/extensions/oper-tag.md) | [Original](https://ircv3.net/specs/extensions/oper-tag) |
| Message IDs | [Open](ircv3/specs/extensions/message-ids.md) | [Original](https://ircv3.net/specs/extensions/message-ids) |
| Metadata | [Open](ircv3/specs/extensions/metadata.md) | [Original](https://ircv3.net/specs/extensions/metadata) |
| Monitor | [Open](ircv3/specs/extensions/monitor.md) | [Original](https://ircv3.net/specs/extensions/monitor) |
| `extended-monitor` Extension | [Open](ircv3/specs/extensions/extended-monitor.md) | [Original](https://ircv3.net/specs/extensions/extended-monitor) |
| Multiline Messages | [Open](ircv3/specs/extensions/multiline.md) | [Original](https://ircv3.net/specs/extensions/multiline) |
| `server-time` Extension | [Open](ircv3/specs/extensions/server-time.md) | [Original](https://ircv3.net/specs/extensions/server-time) |
| Server Name Indication | [Open](ircv3/docs/sni.md) | [Original](https://ircv3.net/docs/sni) |
| Standard Replies | [Open](ircv3/specs/extensions/standard-replies.md) | [Original](https://ircv3.net/specs/extensions/standard-replies) |
| Strict Transport Security | [Open](ircv3/specs/extensions/sts.md) | [Original](https://ircv3.net/specs/extensions/sts) |
| UTF8ONLY ISUPPORT token | [Open](ircv3/specs/extensions/utf8-only.md) | [Original](https://ircv3.net/specs/extensions/utf8-only) |
| WebIRC Extension | [Open](ircv3/specs/extensions/webirc.md) | [Original](https://ircv3.net/specs/extensions/webirc) |
| WebSocket support | [Open](ircv3/specs/extensions/websocket.md) | [Original](https://ircv3.net/specs/extensions/websocket) |
| `tls` Extension | [Open](ircv3/specs/deprecated/tls.md) | [Original](https://ircv3.net/specs/deprecated/tls) |
