> Source: https://ircv3.net/specs/extensions/network-icon Captured: 2026-10-26

# Network Icon

Copyright © 2025 Simon Ser \<contact@emersion.fr>

Copyright © 2026 Sadie Powell \<sadie@sadiepowell.dev>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

This specification is a work-in-progress and may have major incompatible changes without warning.

This specification may change at any time and we do not recommend implementing it in a production environment.

---

<a id="notes-for-implementing-work-in-progress-version"></a>

## Notes for implementing work-in-progress version [🔗](#notes-for-implementing-work-in-progress-version)

This is a work-in-progress specification.

Software implementing this work-in-progress specification MUST NOT use the unprefixed `ICON` ISUPPORT name. Instead, implementations SHOULD use the `draft/ICON` ISUPPORT name to be interoperable with other software implementing a compatible work-in-progress version.

The final version of the specification will use unprefixed ISUPPORT names.

<a id="description"></a>

## Description [🔗](#description)

The `NETWORK` ISUPPORT token allows servers to advertise their network name. This specification adds a new ISUPPORT token to advertise a network icon.

<a id="the-drafticon-isupport-token"></a>

## The `draft/ICON` ISUPPORT token [🔗](#the-drafticon-isupport-token)

If a server publishes a `draft/ICON` ISUPPORT token, the value MUST be a URL to an image. This image SHOULD be square. The URL SHOULD use the “https” scheme.

The URL MAY contain the `{size}` template variable that clients MAY replace with an integer to request a specific image size in pixels. Clients MUST treat this template variable as a hint and MUST NOT assume that they will get the exact same size image back as requested. Servers advertising a URL with the `{size}` variable SHOULD serve a default size when the literal string {size} is requested, in order to support clients that do not perform URL template interpolation.

Servers MAY implement [extended-isupport](extended-isupport.md) to allow clients to fetch the network icon before connection registration.

<a id="examples"></a>

## Examples [🔗](#examples)

This section is non-normative.

Server using an SVG icon:

```
S: :irc.example.org 005 * NETWORK=Example draft/ICON=https://example.org/icon.svg :are supported by this server
```

Server using a PNG icon that can be scaled using the `{size}` template variable:

```
S: :irc.example.org 005 * NETWORK=Example draft/ICON=https://example.net/icon.png?size={size} :are supported by this server
```

---

Software supporting draft/network-icon: [UnrealIRCd](https://www.unrealircd.org), [bIRC](https://birc.app), [Halloy](https://halloy.chat), [Mango](https://mangoirc.chat), [IRCCloud](https://www.irccloud.com), [Tubes](https://tubes.pronounmail.com), [Obby](https://github.com/obbyworld/obby), [Goguma](https://codeberg.org/emersion/goguma)
