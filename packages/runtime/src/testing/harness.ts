/**
 * What the Runtime's own tests share: the in-memory ports, a Logger that keeps what was
 * logged, and ways to wait for the Runtime to catch up. Not part of the test kit's
 * interface.
 *
 * @packageDocumentation
 */
import type { Client } from "@iirc/client";
import type { FallbackEncoding } from "@iirc/protocol/line";
import { Effect, Exit, Layer, Logger, Option, Scope, Stream } from "effect";
import type { LogLevel } from "effect";
import { TestClock } from "effect/testing";

import { Journal } from "../journal.ts";
import type { Entry, JournalRecord, JournalService, JournalFailed } from "../journal.ts";
import { makeRuntime } from "../runtime.ts";
import type { DecodersMissing, RuntimeService } from "../runtime.ts";
import { Transport } from "../transport.ts";
import { Vault } from "../vault.ts";
import type { VaultService } from "../vault.ts";
import { makeMemoryJournal } from "./memory-journal.ts";
import { makeMemoryTransport } from "./memory-transport.ts";
import type { MemoryTransport } from "./memory-transport.ts";
import { makeMemoryVault } from "./memory-vault.ts";

/** 2026-01-01T00:00:00Z, where every test's clock starts. */
export const epoch = 1_767_225_600_000;

/** One line logged. */
interface Logged {
  readonly level: LogLevel.LogLevel;
  readonly message: unknown;
}

/** The ports a Runtime runs on in a test, which outlive any one Runtime. */
export interface World {
  readonly journal: JournalService;
  readonly memory: MemoryTransport;
  readonly vault: VaultService;
  readonly logged: Logged[];
}

/**
 * Fresh in-memory ports.
 * @param journal - A Journal to use instead of a fresh one.
 * @returns The world.
 */
const makeWorld = (journal?: JournalService): Effect.Effect<World> =>
  Effect.gen(function* () {
    return {
      journal: journal ?? (yield* makeMemoryJournal),
      logged: [],
      memory: yield* makeMemoryTransport,
      vault: yield* makeMemoryVault,
    };
  });

/**
 * Starts a Runtime on a world's ports, in its own Scope, so a test can close it and
 * start another on the same Journal.
 * @param world - The ports.
 * @param client - The Client to drive.
 * @param missing - The decoders to report missing.
 * @returns The Runtime, and a way to close it.
 */
export const startRuntime = <S>(
  world: World,
  client: Client<S>,
  missing?: () => readonly FallbackEncoding[]
): Effect.Effect<
  { readonly runtime: RuntimeService; readonly close: Effect.Effect<void> },
  DecodersMissing | JournalFailed
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const runtime = yield* makeRuntime(client, missing).pipe(
      Scope.provide(scope),
      Effect.provideService(Journal, world.journal),
      Effect.provideService(Transport, world.memory.transport),
      Effect.provideService(Vault, world.vault),
      Effect.onError(() => Scope.close(scope, Exit.void))
    );

    return { close: Scope.close(scope, Exit.void), runtime };
  });

/**
 * Runs a test on a TestClock set to the epoch, with what is logged kept in the world.
 * @param test - The test, given fresh ports.
 * @returns A promise of its result.
 */
export const runTest = async <A, E>(test: (world: World) => Effect.Effect<A, E>): Promise<A> => {
  const world = await Effect.runPromise(makeWorld());

  const keep = Logger.make(({ logLevel, message }) => {
    world.logged.push({ level: logLevel, message });
  });

  return await Effect.runPromise(
    Effect.andThen(TestClock.setTime(epoch), test(world)).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), Logger.layer([keep])))
    )
  );
};

/**
 * Lets every other fiber run until nothing is left to do, which in-memory ports reach
 * quickly, as nothing they do waits on the outside world.
 */
export const settle: Effect.Effect<void> = Effect.gen(function* () {
  for (let turn = 0; turn < 200; turn += 1) {
    yield* Effect.yieldNow;
  }
});

/**
 * Every Entry in the Journal now.
 * @param journal - The Journal.
 * @returns Its Entries, in order.
 */
export const entries = (journal: JournalService): Effect.Effect<readonly Entry[], JournalFailed> =>
  Stream.runCollect(journal.read({}));

/**
 * Waits for the first Entry whose record matches.
 * @param journal - The Journal.
 * @param matches - What to wait for.
 * @returns The Entry.
 */
export const awaitRecord = (
  journal: JournalService,
  matches: (record: JournalRecord) => boolean
): Effect.Effect<Entry, JournalFailed> =>
  journal.follow({}).pipe(
    Stream.filter((entry) => matches(entry.record)),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  );

/**
 * Each record in the Journal written short, for comparing in order: an Input by its tag
 * and the fields that tell it apart, and Outputs by their tags.
 * @param journal - The Journal.
 * @returns One string per Entry.
 */
export const outline = (journal: JournalService): Effect.Effect<readonly string[], JournalFailed> =>
  Effect.map(entries(journal), (all) =>
    all.map(({ record, sequence }) =>
      record._tag === "Input"
        ? `${sequence} ${record.network} ${record.input._tag}`
        : `${sequence} ${record.network} of ${record.of}: ${record.outputs.map((output) => output._tag).join(" ")}`
    )
  );

/** What a wrapped Journal does around each append. */
export interface AppendHooks {
  /** Before the append, and may fail it. */
  readonly before?: (record: JournalRecord) => Effect.Effect<void, JournalFailed>;
  /** Once the append is kept. */
  readonly after?: (record: JournalRecord) => Effect.Effect<void>;
}

/**
 * A Journal that does something around each append, such as fail, wait, or note it.
 * @param inner - The Journal that keeps the records.
 * @param hooks - What to do.
 * @returns The wrapped Journal.
 */
export const wrapJournal = (inner: JournalService, hooks: AppendHooks): JournalService => ({
  append: (record) =>
    Effect.andThen(
      hooks.before?.(record) ?? Effect.void,
      Effect.tap(inner.append(record), () => hooks.after?.(record) ?? Effect.void)
    ),
  follow: inner.follow,
  read: inner.read,
});
