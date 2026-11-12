# Nick vectors

`vectors.ts` holds, as plain data, names and the Network's rules they are read under, `CHANTYPES`, `PREFIX`'s symbols, and `STATUSMSG`, and whether the Client's `parseNick` reads each as a nick. Where the web frontend's `isLookupNick`, which reads the nick of `/whois` and `/whowas` before anything is sent, says otherwise on purpose, the vector says what it says and why.

They sit at the repository's root because two packages share them and neither owns them: `packages/client/src/names.test.ts` and `packages/frontend/src/lookup.test.ts` both run every one. Neither package's production code imports the other's, so the copy cannot drift from the rules unseen only because both run these.
