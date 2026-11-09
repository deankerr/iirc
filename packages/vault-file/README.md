# @iirc/vault-file

The production adapter of the Vault port: it holds Credentials in one file. It provides `Vault` from `@iirc/runtime/vault` as a Layer, and keeps the port's written interface (see "Vault" in [the Runtime's README](../runtime/README.md#vault)) and every one of `vaultLaws`.

```ts
import { layerBun } from "@iirc/vault-file";

layerBun(path: string): Layer<Vault>
layer(path: string): Layer<Vault, never, FileSystem | Path> // on a platform you bring
```

`layerBun` is for the composition root. `layer` takes Effect's `FileSystem` and `Path` from the context, which is how the tests give it a file system that fails on demand.

## The file

```json
{
  "version": 1,
  "credentials": {
    "libera-password": "the value",
    "oftc-password": "another value"
  }
}
```

- **Versioned JSON, decoded with a Schema.** A later format is a new `version`, never a reinterpretation of this one. A file that is not JSON, has another version, or has the wrong shape is `VaultFailed`.
- **Mode `0600`.** The file is created owner-only, and every write replaces it with a new `0600` file, so a file that was more open is closed on the next change.
- **The directory must exist.** The adapter never creates parents. A missing directory is `VaultFailed` for every call, and the Vault works again once the directory is made.
- **A missing file is an empty Vault.** Reading never creates it. The first `hold` does.
- **A file it cannot read is never overwritten.** The Owner fixes or removes it, and the next call reads it again. Only a successful read is kept in memory.

## Writes

Every change writes the whole Vault to `<path>.tmp` in the same directory (created with `wx`, so never into an older file), writes it, `fsync`s it, renames it over the file, then best-effort `fsync`s the directory. A crash leaves the old file or the new one, never half of either, and an earlier crash's `.tmp` is removed first. A failed write removes its `.tmp`, and leaves both the file and the memory as they were.

Changes go one at a time through a lock, so concurrent `hold` and `forget` through one Layer never lose an update. The change and the memory it updates are not interrupted between the two.

## In memory

The file is read once, when first needed, and then held in memory as `Redacted` values. One Daemon owns the file, so nothing re-reads it, and an edit made by hand while the Daemon runs is not seen until the next start. Two Layers on one path are two owners, and they will overwrite each other.

## What a value reaches

A value leaves the adapter in one place, `reveal`, as a `Redacted`. It is written only into the file. A `VaultFailed` reason is built from a fixed phrase and the path, or the platform's own message, which names a syscall and a path. It never carries what a decoder or the JSON parser says about the text it was given, because that quotes the text. The tests check that no value appears in an error, a log, or the `String`, `JSON.stringify`, and `util.inspect` of the service and what it returns, on every failure path.

The file itself holds the values in plain text. That is the deliberate cost, below.

## What it deliberately does not do

[ADR 0006](../../docs/adr/0006-proportionate-security.md) puts the threat in hostile Networks and hostile text, not the Owner's own software, and says that where there is no keyring, Credentials "sit in a plain `credentials.json` with mode `0600`". So this adapter has:

- **No encryption at rest.** A key stored beside the file protects nothing the file mode does not, and one stored anywhere else is a key the Owner has to manage.
- **No keyring.** A keyring adapter is a different Vault adapter, with the same port and the same laws.
- **No sealed file, no dedicated Unix user.**
- **No reading of other users' or processes' access.** It does not check the file's owner or mode when reading, and does not defend against a process that can already read the Owner's files.

Backups copy the file, and so copy the Credentials. The Owner decides where backups go.
