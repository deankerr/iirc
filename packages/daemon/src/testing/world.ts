/**
 * What the Daemon's tests share: the Runtime on the in-memory ports, the projector on a
 * Timeline store, a key made in a temporary data directory, a Logger that keeps what was
 * logged, and the Ircd's side of a floor registration.
 *
 * @packageDocumentation
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Authorization } from "@iirc/api";
import { makeMemoryByteStore } from "@iirc/byte-store/testing";
import type { ByteStoreHarness } from "@iirc/byte-store/testing";
import { client } from "@iirc/client";
import { LinkFetch } from "@iirc/link-fetch";
import type { LinkFetchService } from "@iirc/link-fetch";
import { makeFakeLinkFetch } from "@iirc/link-fetch/testing";
import { PreviewCache } from "@iirc/preview-cache";
import type { PreviewCacheService } from "@iirc/preview-cache";
import { makeMemoryPreviewCache } from "@iirc/preview-cache/testing";
import { layerRuntime } from "@iirc/runtime";
import type { RuntimeOptions } from "@iirc/runtime";
import { Journal, JournalFailed } from "@iirc/runtime/journal";
import type { JournalRecord, JournalService } from "@iirc/runtime/journal";
import { makeMemoryJournal, makeMemoryTransport, makeMemoryVault } from "@iirc/runtime/testing";
import type { MemoryTransport, TestCall } from "@iirc/runtime/testing";
import { Transport } from "@iirc/runtime/transport";
import { Vault } from "@iirc/runtime/vault";
import type { VaultService } from "@iirc/runtime/vault";
import { TimelineStore } from "@iirc/timeline-store";
import type { TimelineStoreService } from "@iirc/timeline-store";
import { makeMemoryTimelineStore } from "@iirc/timeline-store/testing";
import { Effect, Layer, Logger, Redacted, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";

import { layerAwayWhenClosed } from "../away-when-closed.ts";
import { ApiKeys, createKey } from "../keys.ts";
import { layerLinkListener } from "../link-listener.ts";
import { OwnerConfiguration, layerOwnerConfiguration } from "../options.ts";
import { layerPreviews } from "../previews/previews.ts";
import { layerProjector } from "../projector.ts";
import { SignIns } from "../sign-ins.ts";
import { layerStoreBytes } from "../store-bytes.ts";
import { layerTail } from "../tail.ts";
import { layerUiConfiguration } from "../ui.ts";
import { ByteStoreMaker, layerUploads } from "../uploads/uploads.ts";

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

const StoredSignIns = Schema.fromJsonString(
  Schema.Struct({ signIns: Schema.Array(Schema.Struct({ sha256: Schema.String })) })
);

const decodeStoredSignIns = Schema.decodeUnknownSync(StoredSignIns);

/**
 * The SHA-256 of each token `sign-ins.json` holds, in order.
 * @param dataDir - The data directory.
 * @returns The hashes, none if there is no file.
 */
export const storedSignIns = (dataDir: string): readonly string[] => {
  const file = `${dataDir}/sign-ins.json`;

  return existsSync(file)
    ? decodeStoredSignIns(readFileSync(file, "utf-8")).signIns.map((signIn) => signIn.sha256)
    : [];
};

/** What a test's Daemon runs on, which outlives one Runtime. */
export interface World {
  readonly journal: JournalService;
  readonly memory: MemoryTransport;
  readonly vault: VaultService;
  readonly store: TimelineStoreService;
  /** The byte store, in memory, reached from any bucket but {@link unreachableEndpoint}. */
  readonly bytes: ByteStoreHarness;
  /** How Previews fetch a link: a fake that answers none unless the test gave one. */
  readonly links: LinkFetchService;
  /** What Previews are kept in: in memory unless the test gave another. */
  readonly previews: PreviewCacheService;
  readonly logged: string[];
}

/** A bucket endpoint the world's byte store cannot reach, failing everything as unavailable. */
export const unreachableEndpoint = "http://unreachable.invalid";

/**
 * Fresh in-memory ports, and somewhere to keep what is logged.
 * @param journal - A Journal to use instead of a fresh one.
 * @param store - A Timeline store to use instead of a fresh one in memory.
 * @param links - A link fetch to use instead of a fake that answers no link.
 * @param previews - A Preview cache to use instead of a fresh one in memory.
 * @returns The world.
 */
export const makeWorld = (
  journal?: JournalService,
  store?: TimelineStoreService,
  links?: LinkFetchService,
  previews?: PreviewCacheService
): Effect.Effect<World> =>
  Effect.gen(function* () {
    return {
      bytes: yield* makeMemoryByteStore,
      journal: journal ?? (yield* makeMemoryJournal),
      links: links ?? (yield* makeFakeLinkFetch({})).service,
      logged: [],
      memory: yield* makeMemoryTransport,
      previews: previews ?? (yield* makeMemoryPreviewCache),
      store: store ?? (yield* makeMemoryTimelineStore),
      vault: yield* makeMemoryVault,
    };
  });

/**
 * The Runtime, on the world's ports, with the real Client, the projector folding its News
 * into the world's Timeline store, the `ui` options and those beyond `ui`
 * folded from the Journal's Changes, the Runtime sparing the Credentials those name, the
 * Previews and the Uploads on the world's byte store, staged in a data directory, and their link listener,
 * Self marked away while no Frontend is open, and the keys and browser sign-ins of that directory.
 * @param world - The ports.
 * @param dataDir - Where the keys and the sign-ins are.
 * @param pacing - How fast Lines leave each Connection, the Runtime's own unless given.
 * @returns The Layer.
 */
export const layerWorld = (world: World, dataDir: string, pacing?: RuntimeOptions["pacing"]) => {
  const bytes = Layer.succeed(ByteStoreMaker, ({ endpoint }) =>
    Effect.succeed(endpoint === unreachableEndpoint ? world.bytes.unreachable : world.bytes.store)
  );

  return Layer.mergeAll(
    Layer.mergeAll(
      layerProjector,
      layerPreviews.pipe(
        Layer.provideMerge(layerUiConfiguration),
        Layer.provide(Layer.merge(Layer.succeed(LinkFetch, world.links), bytes))
      ),
      layerLinkListener,
      layerAwayWhenClosed
    ).pipe(
      // The one Uploads instance is the Previews' and the link listener's.
      Layer.provideMerge(layerUploads(dataDir).pipe(Layer.provide(Layer.merge(bytes, platform)))),
      Layer.provideMerge(
        layerStoreBytes.pipe(Layer.provideMerge(Layer.succeed(PreviewCache, world.previews)))
      ),
      Layer.provideMerge(Layer.succeed(TimelineStore, world.store)),
      Layer.provideMerge(
        Layer.unwrap(
          OwnerConfiguration.useSync((owner) =>
            layerRuntime(client, { pacing, spared: owner.spared })
          )
        ).pipe(
          Layer.provideMerge(layerOwnerConfiguration),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(Journal, world.journal),
              Layer.succeed(Transport, world.memory.transport),
              Layer.succeed(Vault, world.vault)
            )
          )
        )
      )
    ),
    SignIns.layer(dataDir).pipe(
      Layer.provideMerge(ApiKeys.layer(dataDir)),
      Layer.provide(platform)
    ),
    // The Tail alone, which keeps nothing unless a test puts its Logger in force.
    layerTail("0.0.0")
  ).pipe(
    // Beneath every other Layer, so what one says as it is built is kept too, not printed.
    Layer.provideMerge(
      Logger.layer([
        Logger.make(({ message }) => {
          world.logged.push(JSON.stringify(message));
        }),
      ])
    )
  );
};

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
