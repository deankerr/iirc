> Source: https://ircv3.net/docs/sni Captured: 2026-10-26

# Server Name Indication

Copyright © 2015 Attila Molnar \<attilamolnar@hush.com>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

Server Name Indication (SNI) is a mechanism in the TLS protocol in which a TLS client indicates at the beginning of the handshake which hostname it is connecting to.

<a id="uses"></a>

## Uses [🔗](#uses)

Servers can use this information to choose which certificate to send to the client. This is needed because servers may have more than one certificate, for example a server may have two certificates: one for irc.example.net and another one for server.example.net. In this scenario, when a client connects the server has no way of knowing which certificate to offer because it does not know at the time of the handshake which hostname the client is using.

SNI fixes this problem by sending the hostname to the server early, so the server can choose the certificate corresponding to the hostname the client is using.

<a id="requirements"></a>

## Requirements [🔗](#requirements)

Clients MUST use SNI when connecting to servers via TLS. (This implies that a TLS version capable of SNI, i.e. at least TLS 1.1, is required.)

---
