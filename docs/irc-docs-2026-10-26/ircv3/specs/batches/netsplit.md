> Source: https://ircv3.net/specs/batches/netsplit Captured: 2026-10-26

# `netsplit` and `netjoin` Batch Types

Copyright © 2014 Alex Iadicicco \<http://github.com/aji>

Unlimited redistribution and modification of this document is allowed provided that the above copyright notice and this permission notice remains intact.

---

<a id="description"></a>

## Description [🔗](#description)

This document describes the format of the `netsplit` and `netjoin` batch types.

When a netsplit occurs, the server MUST put all resulting QUITs into a single `netsplit` batch. Similarly, all netjoin-related JOINs MUST be put into a _single_ `netjoin` batch. Both types have 2 arguments, which are the names of the servers that are splitting or joining, or \*.net \*.split and \*.net \*.join if the server has chosen to hide links.

Clients that do not understand the `netsplit` and `netjoin` batch types can safely interpret the batched QUITs and JOINs as standard QUITs and JOINs.

<a id="example"></a>

## Example [🔗](#example)

An example netsplit is as follows:

```
:irc.host BATCH +yXNAbvnRHTRBv netsplit irc.hub other.host
@batch=yXNAbvnRHTRBv :aji!a@a QUIT :irc.hub other.host
@batch=yXNAbvnRHTRBv :nenolod!a@a QUIT :irc.hub other.host
@batch=yXNAbvnRHTRBv :jilles!a@a QUIT :irc.hub other.host
:irc.host BATCH -yXNAbvnRHTRBv
```

An example netjoin is as follows:

```
:irc.host BATCH +4lMeQwsaOMs6s netjoin irc.hub other.host
@batch=4lMeQwsaOMs6s :aji!a@a JOIN #atheme
@batch=4lMeQwsaOMs6s :nenolod!a@a JOIN #atheme
@batch=4lMeQwsaOMs6s :jilles!a@a JOIN #atheme
@batch=4lMeQwsaOMs6s :nenolod!a@a JOIN #ircv3
@batch=4lMeQwsaOMs6s :jilles!a@a JOIN #ircv3
@batch=4lMeQwsaOMs6s :Elizacat!a@a JOIN #ircv3
:irc.host BATCH -4lMeQwsaOMs6s
```

<a id="errata"></a>

## Errata [🔗](#errata)

For consistency with capabilities and tags these types were renamed to lower case (from `NETSPLIT` to `netsplit`).

---
