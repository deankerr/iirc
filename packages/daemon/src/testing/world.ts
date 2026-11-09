/**
 * What the Daemon's tests share: the Runtime on the in-memory ports, a key made in a
 * temporary data directory, a Logger that keeps what was logged, and the Ircd's side of
 * a floor registration.
 *
 * @packageDocumentation
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Authorization } from "@iirc/api";
import { client } from "@iirc/client";
import { layerRuntime } from "@iirc/runtime";
import { Journal, JournalFailed } from "@iirc/runtime/journal";
import type { JournalRecord, JournalService } from "@iirc/runtime/journal";
import { makeMemoryJournal, makeMemoryTransport, makeMemoryVault } from "@iirc/runtime/testing";
import type { MemoryTransport, TestCall } from "@iirc/runtime/testing";
import { Transport } from "@iirc/runtime/transport";
import { Vault } from "@iirc/runtime/vault";
import type { VaultService } from "@iirc/runtime/vault";
import { Effect, Layer, Logger, Redacted } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

import { ApiKeys, createKey } from "../keys.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Crypto and the file system, as the key commands and the keys service need them. */
const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  Digest.layerWebCrypto,
  SecureRandom.layerWebCrypto
);

/**
 * A fresh temporary directory, removed when the test's Scope closes.
 * @returns Its path.
 */
export const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "iirc-daemon-"))),
  (directory) =>
    Effect.sync(() => {
      rmSync(directory, { force: true, recursive: true });
    })
);

/**
 * Makes a key in a data directory, as `iirc key create` does.
 * @param dataDir - The data directory.
 * @param name - The key's name.
 * @returns The key.
 */
export const makeKey = (dataDir: string, name = "test") =>
  createKey(dataDir, name).pipe(Effect.map(Redacted.value), Effect.provide(platform), Effect.orDie);

/** What a test's Daemon runs on, which outlives one Runtime. */
export interface World {
  readonly journal: JournalService;
  readonly memory: MemoryTransport;
  readonly vault: VaultService;
  readonly logged: string[];
}

/**
 * Fresh in-memory ports, and somewhere to keep what is logged.
 * @param journal - A Journal to use instead of a fresh one.
 * @returns The world.
 */
export const makeWorld = (journal?: JournalService): Effect.Effect<World> =>
  Effect.gen(function* () {
    return {
      journal: journal ?? (yield* makeMemoryJournal),
      logged: [],
      memory: yield* makeMemoryTransport,
      vault: yield* makeMemoryVault,
    };
  });

/**
 * The Runtime, on the world's ports, with the real Client, and the keys of a data
 * directory.
 * @param world - The ports.
 * @param dataDir - Where the keys are.
 * @returns The Layer.
 */
export const layerWorld = (world: World, dataDir: string) =>
  Layer.mergeAll(
    layerRuntime(client).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(Journal, world.journal),
          Layer.succeed(Transport, world.memory.transport),
          Layer.succeed(Vault, world.vault)
        )
      )
    ),
    ApiKeys.layer(dataDir).pipe(Layer.provide(platform)),
    Logger.layer([
      Logger.make(({ message }) => {
        world.logged.push(JSON.stringify(message));
      }),
    ])
  );

/**
 * The client side of the key check, presenting a key, or none.
 * @param key - The key to present.
 * @returns The Layer.
 */
export const presenting = (key: string | undefined) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(key === undefined ? request : HttpClientRequest.bearerToken(request, key))
  );

/**
 * The next Line the Client sent, as text, without its line ending.
 * @param call - The Connection.
 * @returns The Line.
 */
export const heard = (call: TestCall) =>
  call.heard.pipe(Effect.map((bytes) => decoder.decode(bytes).replace(/\r\n$/u, "")));

/**
 * Says a Line as the Ircd.
 * @param call - The Connection.
 * @param line - The Line, without its line ending.
 * @returns An Effect that says it.
 */
export const say = (call: TestCall, line: string) => call.say(encoder.encode(line));

/**
 * Plays an Ircd with no cap negotiation through registration, checking the Lines the
 * Client sends first.
 * @param memory - The Transport's Ircd side.
 * @param expected - The Lines the Client sends before the Ircd answers.
 * @returns The Connection, registered as `iirc`.
 */
export const registerOnFloor = (
  memory: MemoryTransport,
  expected: readonly string[] = ["CAP LS 302", "NICK iirc", "USER iirc 0 * iirc"]
) =>
  Effect.gen(function* () {
    const call = yield* memory.ircd.accept;

    yield* call.open;
    const lines: string[] = [];

    for (const _ of expected) {
      lines.push(yield* heard(call));
    }

    if (lines.join("\n") !== expected.join("\n")) {
      return yield* Effect.die(new Error(`registration sent ${JSON.stringify(lines)}`));
    }

    yield* say(call, ":irc.test 421 iirc CAP :Unknown command");
    yield* say(call, ":irc.test 001 iirc :Welcome");

    return call;
  });

/** What a wrapped Journal does to an append, by its record. */
export type AppendFault = (record: JournalRecord) => "fail" | "keep";

/**
 * A Journal that fails the appends a fault picks, and keeps the rest in another.
 * @param inner - The Journal that keeps what is kept.
 * @param fault - Which appends fail.
 * @returns The wrapped Journal.
 */
export const faultyJournal = (inner: JournalService, fault: AppendFault): JournalService => ({
  append: (record) =>
    fault(record) === "fail"
      ? Effect.fail(new JournalFailed({ reason: "the test failed this append" }))
      : inner.append(record),
  follow: inner.follow,
  read: inner.read,
});
