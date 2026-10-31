> Source: https://ircv3.net/specs/deprecated/tls Captured: 2026-10-26

# `tls` Extension

Copyright © 2012 William Pitcock \<nenolod@dereferenced.org>

Copyright © 2014 Attila Molnar \<attilamolnar@hush.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

This specification has been deprecated. We do not recommend implementing this specification or the features described here.

---

<a id="description"></a>

## Description [🔗](#description)

The tls client capability indicates that the server supports the STARTTLS command.

It is worth noting here that a client may request the tls capability with CAP REQ, but this won’t affect that client’s ability to later send the STARTTLS command. The STARTTLS command will always operate on servers which advertise the capability regardless of if the client requests the capability or not.

To use STARTTLS a client simply sends the STARTTLS command to the server before the client registers with the server using the NICK and USER commands, the server then sends numeric 670 (RPL\_STARTTLS), and the client initiates a SSL/TLS handshake.

If there is an error with setting up TLS on the server side, the server must send numeric 691 (ERR\_STARTTLS) containing a human-readable description of the error as its parameter.

<a id="recommendations"></a>

## Recommendations [🔗](#recommendations)

If the user has not configured the connection to be explicitly plaintext and the client sees the server advertising the `tls` capability, the client should ask the user whether they want to use TLS for all future connections (or until disabled manually). If the user agrees, all future connections to the server must use TLS via STARTTLS. If TLS cannot be negotiated, it is a hard error and the client must abort the connection. This is to make sure that the connection cannot be downgraded to plaintext by a man-in-the-middle once it has been established that TLS support is available.

It should be assumed that once a server has advertised TLS support it is not going to stop supporting it. This is similar to how SSL-only ports are not expected to go away.

<a id="numerics-used-by-this-extension"></a>

## Numerics used by this extension [🔗](#numerics-used-by-this-extension)

`670` aka `RPL_STARTTLS` to indicate that the client may begin the TLS handshake.

```
:server 670 <nick> :STARTTLS successful, proceed with TLS handshake
```

`691` aka `ERR_STARTTLS` to indicate that a server-side error has occurred.

```
:server 691 <nick> :STARTTLS failed (Wrong moon phase)
```

_(The final “text” parameter is not to be machine-parsed, as it tends to vary between implementations and translations.)_

<a id="errata"></a>

## Errata [🔗](#errata)

- This extension has been [deprecated](https://github.com/ircv3/ircv3.github.io/pull/211) in favour of encouraging IRC networks to use implicit TLS and deploy [Strict Transport Security](../extensions/sts.md) instead. This is in alignment with the recommendations given in [RFC 8314](https://tools.ietf.org/html/rfc8314).

---
