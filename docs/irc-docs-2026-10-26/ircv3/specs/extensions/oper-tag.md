> Source: https://ircv3.net/specs/extensions/oper-tag Captured: 2026-10-26

# `oper-tag` Extension

Copyright © 2022 David Schultz \<me@zpld.me>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

This specification is a work-in-progress and may have major incompatible changes without warning.

This specification may change at any time and we do not recommend implementing it in a production environment.

---

<a id="notes-for-implementing-work-in-progress-version"></a>

## Notes for implementing work-in-progress version [🔗](#notes-for-implementing-work-in-progress-version)

This is a work-in-progress specification.

Software implementing this work-in-progress specification MUST NOT use the unprefixed `oper` tag name. Instead, implementations SHOULD use the `draft/oper` tag name to be interoperable with other software implementing a compatible work-in-progress version.

<a id="description"></a>

## Description [🔗](#description)

The `draft/oper-tag` capability causes the server to add a [message tag](message-tags.md) to messages sent by a user who is currently an IRC operator.

The tag MUST be named `draft/oper`. The value of the tag, if specified, MUST identify the operator.

The tag MUST be added by the ircd to all commands sent by a user (e.g. PRIVMSG, MODE, NOTICE, and all others) and SHOULD be added to any numeric replies sent on behalf of the user.

Servers supporting this capability MAY be configured to restrict visibility of this tag or its value.

<a id="example"></a>

## Example [🔗](#example)

Consider that I am identified to the `launchd` operator account while chatting with the `lunchd` nickname. I will send messages to three users with different configured levels of visibility.

```
@draft/oper=launchd :lunchd PRIVMSG full_access_friend :it's me!
@draft/oper :lunchd PRIVMSG partial_access_friend :you can see I'm an oper
:lunchd PRIVMSG unprivileged_friend :don't mind me
```

---

Software supporting draft/oper-tag: [bIRC](https://birc.app)
