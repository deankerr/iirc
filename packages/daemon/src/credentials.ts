import nodePath from "node:path";

import { BunFileSystem } from "@effect/platform-bun";
import { CredentialName, CredentialsUnavailable } from "@iirc/api";
import { Log } from "@iirc/log";
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import { issuesOf } from "./issues.ts";

/** Where Credentials are kept (CRED-1). */
export type CredentialStore = "keyring" | "file";

/**
 * The part of `Bun.secrets` the Credentials service uses, so that a test can stand in
 * for a keyring that answers, refuses, or never answers.
 */
export interface Keyring {
  readonly get: (options: {
    readonly name: string;
    readonly service: string;
  }) => Promise<string | null>;
  readonly set: (options: {
    readonly name: string;
    readonly service: string;
    readonly value: string;
  }) => Promise<void>;
}

/** One Credential as the service holds it: its value, and when it was last set. */
interface Kept {
  /** When it was last set, in epoch milliseconds. */
  readonly set: number;
  readonly value: Redacted.Redacted;
}

type Holding = ReadonlyMap<string, Kept>;

/**
 * Credentials cannot be used as kept, so the Daemon will not start: a file another user
 * may read, one this iirc cannot read, or a keyring that held them and is gone (CRED-1).
 * It never says what a value is.
 */
export class CredentialsUnreadable extends Data.TaggedError("CredentialsUnreadable")<{
  readonly reason: string;
}> {
  override readonly message = `Credentials cannot be read, so the Daemon will not start: ${this.reason}`;
}

/** The file Credentials are kept in when there is no keyring. */
export const credentialsFile = "credentials.json";

// Says that Credentials are in the keyring, so that a start without one refuses rather
// than begin again with none. It holds no secret.
const keyringMarker = "credentials.keyring";

// The only mode the file may have: its owner reads and writes it, and nobody else.
const fileMode = 0o600;

// Everything below the owner's own bits, which a mode leaves as its remainder: any of
// them lets someone else near the file.
const ownerOnly = 0o100;

// How long the keyring may take to answer the probe at startup. A keyring that would
// prompt for an unlock is no use to a Daemon nobody is watching.
const probeTimeout = Duration.seconds(2);

// How long a caller waits for one write to a store. A keyring that answered the probe can
// still stop answering, as one does when it locks, and a write that never ends must not
// hold up every Change and the Daemon's stop behind it.
const defaultWriteTimeout = Duration.seconds(10);

const keyringService = "iirc";

/**
 * Every Credential, as both stores keep them: one JSON document of names, each with its
 * value and when it was set. Whole in one place, so one replacement swaps all of it.
 */
const Stored = Schema.Record(
  CredentialName,
  Schema.Struct({ set: Schema.Int, value: Schema.RedactedFromValue(Schema.String) })
);

// A name that is no Credential name is an error, not dropped, or the next write would
// lose whatever a hand edit put there.
const decodeStored = Schema.decodeUnknownResult(Stored, { onExcessProperty: "error" });

/**
 * Reads what a store holds. Neither failure repeats what it read: the JSON parser quotes
 * the text near a mistake, and a value may be there, so a mistake is named only by where.
 * @param text - The document.
 * @returns The Credentials, or why it is not a Credentials document.
 */
const parseStored = (text: string): Result.Result<Holding, string> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return Result.fail("it is not JSON");
  }

  return Result.match(decodeStored(parsed), {
    onFailure: ({ issue }) =>
      Result.fail(
        `it is not as this iirc writes it, at ${issuesOf(issue, [])
          .map(({ path }) => (path.length === 0 ? "the top" : path.join(".")))
          .join(", ")}`
      ),
    onSuccess: (stored) => Result.succeed(new Map(Object.entries(stored))),
  });
};

// The only place a value leaves its Redacted, which is to be written where it is kept.
const documentOf = (holding: Holding) =>
  Redacted.make(
    `${JSON.stringify(
      Object.fromEntries(
        [...holding].map(([name, { set, value }]) => [name, { set, value: Redacted.value(value) }])
      ),
      undefined,
      2
    )}\n`
  );

/** Where Credentials are kept, once chosen. */
interface Slot {
  readonly store: CredentialStore;
  /** Replaces every Credential at once, so a crash leaves the old ones or the new ones. */
  readonly write: (document: Redacted.Redacted) => Effect.Effect<void, CredentialsUnavailable>;
}

const unavailable = (reason: string) => new CredentialsUnavailable({ reason });

const sync = (fileSystem: FileSystem.FileSystem, path: string) =>
  Effect.scoped(Effect.flatMap(fileSystem.open(path, { flag: "r" }), (file) => file.sync));

/**
 * Writes a small file so that it survives power loss: the file is synced, and then so is
 * the directory that names it, because a synced file can still be missing from a directory
 * that was not.
 * @param fileSystem - The file system.
 * @param path - The file.
 * @param text - What it holds.
 * @returns An effect that ends once both are on disk.
 */
const writeDurably = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  text: string
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(path, { flag: "w" });

      yield* file.writeAll(new TextEncoder().encode(text));
      yield* file.sync;
    })
  );
  yield* sync(fileSystem, nodePath.dirname(path));
});

/**
 * The file, replaced atomically (CRED-1): written whole to a temporary file of mode
 * `0600`, synced, and renamed over the old one, and then the directory is synced so that
 * the rename survives power loss. A crash at any point leaves the old file or the new one.
 * @param fileSystem - The file system.
 * @param dataDir - The data directory.
 * @returns The slot.
 */
const fileSlot = (fileSystem: FileSystem.FileSystem, dataDir: string): Slot => {
  const path = `${dataDir}/${credentialsFile}`;
  const partial = `${path}.partial`;

  return {
    store: "file",
    write: (document) =>
      Effect.gen(function* () {
        // A partial file left by a crash is never read, and would otherwise keep its mode.
        yield* fileSystem.remove(partial, { force: true });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(partial, { flag: "wx", mode: fileMode });

            yield* file.writeAll(new TextEncoder().encode(Redacted.value(document)));
            yield* file.sync;
          })
        );
        yield* fileSystem.rename(partial, path);
        yield* sync(fileSystem, dataDir);
      }).pipe(
        // A file system's errors name paths and calls, and never what was being written.
        Effect.mapError((error) =>
          unavailable(`${credentialsFile} could not be written: ${error.message}`)
        )
      ),
  };
};

const keyringSlot = (keyring: Keyring, name: string): Slot => ({
  store: "keyring",
  write: (document) =>
    Effect.tryPromise({
      // What the keyring said is not repeated, because nothing promises it leaves out the value.
      catch: () => unavailable("the keyring would not store them"),
      try: async () => {
        await keyring.set({ name, service: keyringService, value: Redacted.value(document) });
      },
    }),
});

const unreadable = (reason: string) => new CredentialsUnreadable({ reason });

/**
 * Asks the keyring for the Daemon's own entry, which is harmless whether or not there is
 * one, and is the read a start would make anyway. Bun gives no other way to ask whether a
 * keyring is there, and guessing from the environment would be wrong somewhere.
 * @param keyring - The keyring.
 * @param name - The entry's name.
 * @returns What the entry holds, `null` for none, or nothing if no keyring answered in time.
 */
const probe = (keyring: Keyring, name: string) =>
  Effect.tryPromise(async () => await keyring.get({ name, service: keyringService })).pipe(
    Effect.timeoutOption(probeTimeout),
    Effect.orElseSucceed(() => Option.none<string | null>())
  );

const loadFile = Effect.fnUntraced(function* (fileSystem: FileSystem.FileSystem, path: string) {
  const { mode } = yield* fileSystem.stat(path);

  // Refused, not fixed: a looser mode means another user may already have read every
  // Credential, which only the Owner can judge and only rotating them can mend, and a
  // quiet chmod would hide that it ever happened.
  if (mode % ownerOnly !== 0) {
    return yield* unreadable(
      `${path} has mode ${(mode % 0o1000).toString(8).padStart(4, "0")}, so other users may have read it. Rotate anything they could have seen, then run chmod 600 ${path}.`
    );
  }

  return yield* Result.match(parseStored(yield* fileSystem.readFileString(path)), {
    onFailure: (reason) => Effect.fail(unreadable(`${path} cannot be read, because ${reason}`)),
    onSuccess: Effect.succeed,
  });
});

const parseKeyring = (text: string | null) =>
  text === null
    ? Effect.succeed<Holding>(new Map())
    : Result.match(parseStored(text), {
        onFailure: (reason) =>
          Effect.fail(unreadable(`the keyring's entry cannot be read, because ${reason}`)),
        onSuccess: Effect.succeed,
      });

/**
 * Chooses where Credentials are kept and reads them (CRED-1). A file already there wins,
 * because its Credentials are the ones the Owner set. Otherwise a keyring that answers
 * the probe is used, and remembered by a marker, so that a later start without it refuses
 * rather than carry on as if there were no Credentials. Otherwise it is the file.
 * @param options - The data directory, and the keyring to probe.
 * @returns The store, and what it holds.
 */
const choose = Effect.fnUntraced(function* ({ dataDir, keyring }: CredentialsOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = `${dataDir}/${credentialsFile}`;
  const marker = `${dataDir}/${keyringMarker}`;
  const entry = `credentials ${yield* fileSystem.realPath(dataDir)}`;

  // A crash can leave a partial file, which was never the Credentials and may hold one.
  yield* fileSystem.remove(`${path}.partial`, { force: true });

  if (yield* fileSystem.exists(path)) {
    return { holding: yield* loadFile(fileSystem, path), slot: fileSlot(fileSystem, dataDir) };
  }

  const answer = yield* probe(keyring, entry);
  const marked = yield* fileSystem.exists(marker);

  if (Option.isSome(answer)) {
    if (!marked) {
      // Durable before any Credential is stored, or a power loss could leave Credentials in a
      // keyring and no marker, and a start without the keyring would begin again with none.
      yield* writeDurably(fileSystem, marker, `${keyringService}\n${entry}\n`);
    }

    return { holding: yield* parseKeyring(answer.value), slot: keyringSlot(keyring, entry) };
  }

  if (marked) {
    return yield* unreadable(
      `they are kept in the system keyring, which did not answer. Start the keyring's service, or remove ${marker} to begin again with none.`
    );
  }

  return { holding: new Map<string, Kept>(), slot: fileSlot(fileSystem, dataDir) };
});

/** Where Credentials live, and the keyring to try. */
export interface CredentialsOptions {
  readonly dataDir: string;
  /** `Bun.secrets` unless a test stands in for it. */
  readonly keyring: Keyring;
  /** How long a caller waits for a write, 10 seconds unless a test shortens it. */
  readonly writeTimeout?: Duration.Input;
}

/**
 * One write that a caller waits for. The caller may stop waiting, by a timeout or by being
 * cancelled, and the write goes on. Whichever of the caller and the write gets to `state`
 * first decides what the write came to: kept, or undone.
 */
interface Write {
  /** Whether the write has been kept, or its caller left first, so it is to be undone. */
  state: "abandoned" | "settled" | "waiting";
  readonly done: Deferred.Deferred<boolean, CredentialsUnavailable>;
}

const valuesOf = (holding: Holding): ReadonlyMap<string, Redacted.Redacted> =>
  new Map([...holding].map(([name, { value }]) => [name, value]));

/**
 * What the service holds: every Credential, and their values by name, made once for each
 * change. A host is handed the very same values until one changes, which is what keeps
 * scrubbing from building its search again for every append (LOG-6).
 */
interface Held {
  readonly holding: Holding;
  readonly values: ReadonlyMap<string, Redacted.Redacted>;
}

const heldOf = (holding: Holding): Held => ({ holding, values: valuesOf(holding) });

/**
 * The secrets the Daemon uses on the Owner's behalf, kept outside the Log (CRED-1). Values
 * stay `Redacted` from the moment they arrive (CRED-3), and only `all` hands them out,
 * for the Daemon to use and never to show.
 *
 * A write to a store is never cancelled once it has begun, and never overlapped by the
 * next, because a store that is slow to answer may still apply it, and a late write of the
 * whole document would replace what a later one kept. So a write is owned by the service,
 * not by its caller. A caller waits for it at most the write timeout, and is then told
 * `CredentialsUnavailable`, and from then on that write has failed, whatever the store
 * does. If it does end well, the service writes back the document that it holds, which is
 * what it held before the write, and only then lets the next write begin. So what a
 * restart reads is what the Daemon holds, and no Change is ever recorded for a write that
 * its caller was told failed. Until the write and its undoing end, every later write
 * fails at once. If the undoing fails, the store is unavailable until the Daemon restarts,
 * and what the service holds can still be read.
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    /**
     * Every value, by name, to use and never to show (CRED-2). It is the same Map until a
     * Credential is set or deleted.
     */
    readonly all: Effect.Effect<ReadonlyMap<string, Redacted.Redacted>>;
    /** Every value, by name, now and after each change, as `all` gives it. */
    readonly changes: Stream.Stream<ReadonlyMap<string, Redacted.Redacted>>;
    /** Deletes one, and says whether it was there. Nothing is written if it was not. */
    readonly delete: (name: string) => Effect.Effect<boolean, CredentialsUnavailable>;
    /** The names there are, each with when it was last set, ordered by name. */
    readonly names: Effect.Effect<readonly { readonly name: string; readonly set: number }[]>;
    /** Sets one, replacing any value it had, once it is kept. */
    readonly set: (
      name: string,
      value: Redacted.Redacted
    ) => Effect.Effect<void, CredentialsUnavailable>;
    readonly store: CredentialStore;
  }
>()("@iirc/daemon/Credentials") {
  /**
   * Chooses the store and reads every Credential before the Daemon starts. It needs the
   * Log open, because the Log holds the data directory, and nothing else may write here.
   * @param options - The data directory, and the keyring to try.
   * @returns The service.
   */
  static readonly layer = (
    options: CredentialsOptions
  ): Layer.Layer<Credentials, CredentialsUnreadable, Log> =>
    Layer.effect(
      Credentials,
      Effect.gen(function* () {
        yield* Log;

        const { holding, slot } = yield* choose(options).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(unreadable(`the data directory could not be read: ${error.message}`))
          )
        );

        const held = yield* SubscriptionRef.make(heldOf(holding));
        const current = Effect.map(SubscriptionRef.get(held), (now) => now.holding);
        const writeTimeout = options.writeTimeout ?? defaultWriteTimeout;
        const writeMillis = Duration.toMillis(Duration.fromInputUnsafe(writeTimeout));

        // One write at a time, each from what the last left, so none is lost.
        const writing = yield* Semaphore.make(1);

        // When the write that holds the permit began, if one does, and until its undoing has
        // ended too. Whether it is overdue is worked out from this and the clock, so it
        // cannot be left saying so after it ends.
        let began: number | undefined;

        // The store could not be put back, so what it holds is not what the service holds.
        // Nothing is written again until a restart reads it.
        let adrift = false;

        // Runs the write that `plan` works out on a fiber of its own, holding the permit
        // until it and its undoing end, and waits for it only so long. A write queued behind
        // another that nobody waits for is dropped when its turn comes. The state follows
        // the store, so a write that is kept is held in the same step, and a write whose
        // caller has left is undone by writing back what the service holds, before the next
        // write may begin.
        const owned = (plan: Effect.Effect<Holding | undefined>) =>
          Effect.gen(function* () {
            if (adrift) {
              return yield* unavailable(
                "an earlier write could not be undone, so Credentials cannot be written until the Daemon restarts"
              );
            }

            if (began !== undefined && (yield* Clock.currentTimeMillis) - began >= writeMillis) {
              return yield* unavailable("an earlier write to the store has not finished");
            }

            const write: Write = {
              done: yield* Deferred.make<boolean, CredentialsUnavailable>(),
              state: "waiting",
            };

            yield* writing
              .withPermit(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    if (write.state === "abandoned") {
                      return;
                    }

                    // A write queued before an earlier one failed to be undone must not
                    // run once that earlier one lets go of the permit.
                    if (adrift) {
                      Deferred.doneUnsafe(
                        write.done,
                        Exit.fail(
                          unavailable(
                            "an earlier write could not be undone, so Credentials cannot be written until the Daemon restarts"
                          )
                        )
                      );

                      return;
                    }

                    began = yield* Clock.currentTimeMillis;

                    const before = yield* current;
                    const next = yield* plan;

                    if (next === undefined) {
                      began = undefined;
                      Deferred.doneUnsafe(write.done, Exit.succeed(false));

                      return;
                    }

                    const stored = yield* Effect.exit(slot.write(documentOf(next)));

                    if (Exit.isFailure(stored)) {
                      began = undefined;
                      Deferred.doneUnsafe(write.done, stored.pipe(Exit.map(() => false)));

                      return;
                    }

                    // In one step, so that either the caller is told or the write is undone.
                    const kept = yield* Effect.sync(() => {
                      if (write.state !== "waiting") {
                        return false;
                      }

                      write.state = "settled";

                      return true;
                    });

                    if (kept) {
                      yield* SubscriptionRef.set(held, heldOf(next));
                      began = undefined;
                      Deferred.doneUnsafe(write.done, Exit.succeed(true));

                      return;
                    }

                    const undone = yield* Effect.exit(slot.write(documentOf(before)));

                    adrift = Exit.isFailure(undone);
                    began = undefined;
                  })
                )
              )
              .pipe(Effect.forkDetach);

            // Whether the write had ended by the time the caller left. If it had, its
            // outcome stands. If not, the caller is told it failed, whatever comes of it.
            const leave = Effect.sync(() => {
              if (Deferred.isDoneUnsafe(write.done) || write.state === "settled") {
                return true;
              }

              write.state = "abandoned";

              return false;
            });

            return yield* Deferred.await(write.done).pipe(
              Effect.timeoutOption(writeTimeout),
              Effect.onInterrupt(() => leave),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    leave.pipe(
                      Effect.flatMap((ended) =>
                        ended
                          ? Deferred.await(write.done)
                          : Effect.fail(
                              unavailable(
                                "the store did not answer in time, so the write is treated as failed"
                              )
                            )
                      )
                    ),
                  onSome: Effect.succeed,
                })
              )
            );
          });

        return {
          all: Effect.map(SubscriptionRef.get(held), ({ values }) => values),
          changes: Stream.map(SubscriptionRef.changes(held), ({ values }) => values),
          delete: (name) =>
            owned(
              current.pipe(
                Effect.map((before) =>
                  before.has(name)
                    ? new Map([...before].filter(([held]) => held !== name))
                    : undefined
                )
              )
            ),
          names: current.pipe(
            Effect.map((now) =>
              [...now]
                .map(([name, { set }]) => ({ name, set }))
                .toSorted((one, other) => (one.name < other.name ? -1 : 1))
            )
          ),
          set: (name, value) =>
            Effect.asVoid(
              owned(
                Effect.gen(function* () {
                  const set = yield* Clock.currentTimeMillis;

                  return new Map(yield* current).set(name, { set, value });
                })
              )
            ),
          store: slot.store,
        };
      })
    ).pipe(Layer.provide(BunFileSystem.layer));
}
