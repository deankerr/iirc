> Source: https://ircv3.net/specs/extensions/client-batch Captured: 2026-10-26

# Client initiated batch Extension

Copyright © 2021 Val Lorentz \<progval+ircv3@progval.net>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

This specification is a work-in-progress and may have major incompatible changes without warning.

This specification may change at any time and we do not recommend implementing it in a production environment.

---

<a id="notes-for-implementing-work-in-progress-version"></a>

## Notes for implementing work-in-progress version [🔗](#notes-for-implementing-work-in-progress-version)

This is a work-in-progress specification.

All specifications depending on this specification MUST be draft specification and use only capability names prefixed by `draft/`

<a id="introduction"></a>

## Introduction [🔗](#introduction)

This specification extends the [`batch`](batch.md) specification to allow client-initiated BATCH commands.

This specification itself does not introduce any client-to-server batch type, but is designed as a framework for other specifications.

<a id="motivation"></a>

## Motivation [🔗](#motivation)

Certain specifications call for clients to be able to send batched messages to servers, for instance [`draft/multiline`](multiline.md)

<a id="architecture"></a>

## Architecture [🔗](#architecture)

<a id="dependencies"></a>

### Dependencies [🔗](#dependencies)

This specification does not depend on the [`batch`](batch.md) capability, which is used for server-initiated batches only.

This specification uses the [standard replies](standard-replies.md) framework.

<a id="capabilities"></a>

### Capabilities [🔗](#capabilities)

This specification does not introduce any capability.

Clients SHOULD NOT send `BATCH` commands to servers, unless they negotiated a capability that allows them to do so.

<a id="the-client-to-server-batch-verb"></a>

### The client-to-server `BATCH` verb [🔗](#the-client-to-server-batch-verb)

This specification introduces client initiated batches. These use the same syntax as server initiated batches.

Once a client has opened a batch, it MUST NOT send any messages that are not part of the batch, until it is closed (with `BATCH -reference-tag`).

Clients MUST NOT send nested batches, i.e. clients may not send `BATCH` commands with a `batch` tag.

<a id="errors"></a>

### Errors [🔗](#errors)

Servers MUST use `FAIL` messages from the [standard replies](standard-replies.md) framework to notify clients of errors with client-initiated batches. The command is `BATCH` and the following codes are defined:

- `INVALID_REFTAG <reference-tag>`: the provided reference tag contains disallowed characters, all past and future messages in this batch will be ignored.
- `TIMEOUT <reference-tag>`: the batch was left open for too long, all past and future messages in this batch will be ignored.
- `UNKNOWN_TYPE <reference-tag> <type>`: the batch type is not recognized by the server, all past and future messages in this batch will be ignored.

<a id="implementation-considerations"></a>

## Implementation considerations [🔗](#implementation-considerations)

This section is non-normative.

While this version of the client-initated batch framework does not allow nested batches, future extensions may allow them. Client and server implementations may want to take this into account while designing their internal APIs.

---

Software supporting client-batch: [bIRC](https://birc.app)
