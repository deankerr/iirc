# @iirc/vault-file

The production adapter of the Vault port: it holds Credentials in one file. It provides `Vault` from `@iirc/runtime/vault` as a Layer, and keeps every one of `vaultLaws`.

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

Every change writes the whole Vault to `<path>.tmp` in the same directory, then renames it over the file. The temporary file is created with `wx`, so never into an older file, written in full, and `fsync`ed before the rename. A crash leaves the old file or the new one, never half of either.

The rename is the commit. Before it, any failure, whether an error or a defect from closing the temporary file, is a `VaultFailed` with a fixed reason. (Bun's `FileSystem` closes a file in a finalizer that turns a failed close into a defect, so the adapter translates defects rather than letting one escape.) The old file and the memory are left as they were, and the temporary file is removed. After it, nothing can undo the change: the memory is updated straight away, and the best-effort `fsync` of the directory that follows ignores errors and defects alike. So a call that returns has left the file and the memory agreeing, and one that fails has left both as they were.

- **Cleanup is best effort.** A temporary file that cannot be removed stays, the write's own failure is the one reported, and the next write removes it first. If it still cannot be removed, writes fail with `VaultFailed` until it can, rather than write into a file the adapter did not make.
- **A change is not interrupted.** From the first write to the memory update it is uninterruptible, so an interrupted `hold` is either whole or not made, and a call never stops between the rename and the memory update. The cost is that a file system that hangs holds the call.
- **One change at a time.** Changes go through a lock, so concurrent `hold` and `forget` through one Layer never lose an update.

## In memory

The file is read once, when first needed, and then held in memory as `Redacted` values. One Daemon owns the file, so nothing re-reads it, and an edit made by hand while the Daemon runs is not seen until the next start. Two Layers on one path are two owners, and they will overwrite each other.

## What a value reaches

A value leaves the adapter in one place, `reveal`, as a `Redacted`. It is written only into the file. A `VaultFailed` reason is built from a fixed phrase and the path, or the platform's own message, which names a syscall and a path. It never carries what a decoder, the JSON parser, or a defect says, because those can quote what they were given.

The tests check that no value appears in a log, or in the `String`, `JSON.stringify`, and `util.inspect` of the service and what it returns, for an unreadable file and an unwritable directory. For each failure injected at the write boundaries (opening, writing whole or half, `fsync`, closing with a defect that carries a marker the reason must not echo, and renaming), they check the returned error's rendering only, not logs. The cleanup tests check the error that is reported, not its rendering. They do not cover other faults, such as `ENOSPC` in a particular call, which would take the same path as the injected ones.

The file itself holds the values in plain text. That is the deliberate cost, below.

## What it deliberately does not do

ADR 0006 puts the threat in hostile Networks and hostile text, not the Owner's own software, and says that where there is no keyring, Credentials "sit in a plain `credentials.json` with mode `0600`". So this adapter has:

- **No encryption at rest.** A key stored beside the file protects nothing the file mode does not, and one stored anywhere else is a key the Owner has to manage.
- **No keyring.** A keyring adapter is a different Vault adapter, with the same port and the same laws.
- **No sealed file, no dedicated Unix user.**
- **No reading of other users' or processes' access.** It does not check the file's owner or mode when reading, and does not defend against a process that can already read the Owner's files.

Backups copy the file, and so copy the Credentials. The Owner decides where backups go.
