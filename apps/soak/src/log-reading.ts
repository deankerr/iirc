import { DaemonApi, LogUnavailable } from "@iirc/api";
import type { LogEntry, NetworkId } from "@iirc/api";
import { Effect, Option, Stream } from "effect";
import type { Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { boundedBy, folder } from "./folding.ts";
import type { RawGap } from "./folding.ts";

// A Frontend like any other (API-1): everything here is read through the contract's own
// client, with a key, and nothing about a Daemon's Log is known but what the API says.

/**
 * A client of one Daemon's API, sending the key with every request (AUTH-6).
 * @param baseUrl - Where the Daemon's API is.
 * @param key - A key with at least the scope the commands need.
 * @returns The client.
 */
export const clientOf = (baseUrl: string, key: Redacted.Redacted) =>
  HttpApiClient.make(DaemonApi, {
    baseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** A client of a Daemon's API. */
export type Client = Effect.Success<ReturnType<typeof clientOf>>;

/** The most the API gives in one page. */
const pageSize = 1000;

/**
 * Every item after `start`, a page at a time, as a stream, so that a Log is read without
 * being held. A page can come back shorter than asked for, because the Log's reader also
 * stops a page at about 256 KiB of rows (LOG-11), so a short page is no sign of the end.
 * Only an empty page is.
 * @param start - The cursor to read after.
 * @param fetch - One page after a cursor.
 * @param cursor - The cursor an item leaves behind it.
 * @returns Every item, in order.
 */
export const pageStream = <Item, E, R>(
  start: number,
  fetch: (after: number) => Effect.Effect<readonly Item[], E, R>,
  cursor: (item: Item) => number
) =>
  Stream.paginate(start, (after) =>
    Effect.map(fetch(after), (page) => {
      const last = page.at(-1);

      return [
        page,
        last === undefined ? Option.none<number>() : Option.some(cursor(last)),
      ] as const;
    })
  );

/**
 * Every Gap a Daemon recorded on one Network.
 * @param client - A client of the Daemon.
 * @param network - The Network.
 * @returns The Gaps, by the sequence they began at.
 */
const gapsOn = (client: Client, network: NetworkId) =>
  pageStream(
    0,
    (after) => client.daemon.gaps({ query: { after, limit: pageSize, network } }),
    ({ sequence }) => sequence
  ).pipe(
    Stream.runCollect,
    Effect.map((gaps): readonly RawGap[] =>
      gaps.map(({ at, ended, reason, sequence }) => ({
        at,
        endedAt: ended?.at,
        endedSequence: ended?.sequence,
        reason,
        sequence,
      }))
    )
  );

/** Where a pass reads one Network's Log from. */
export interface LogSource<E> {
  /** Entries after a sequence, in order, as far as the Log gives in one page. */
  readonly entries: (after: number) => Effect.Effect<readonly LogEntry[], E>;
  readonly gaps: Effect.Effect<readonly RawGap[], E>;
  /** The newest sequence, which is `null` when the Log cannot be read. */
  readonly head: Effect.Effect<number | null, E>;
}

/**
 * A Daemon's Log as one Network's Entries of some kinds, and its Gaps.
 * @param client - A client of the Daemon.
 * @param network - The Network.
 * @param kind - Which kinds of Entry.
 * @returns The source.
 */
export const sourceOf = (
  client: Client,
  network: NetworkId,
  kind: readonly ["Line", "Dropped"] | readonly ["Line"]
) => ({
  entries: (after: number) =>
    client.daemon.entries({ query: { after, kind, limit: pageSize, network } }),
  gaps: gapsOn(client, network),
  head: Effect.map(client.daemon.status(), ({ head }) => head),
});

/**
 * Reads a Log through a pass that keeps only what it needs, from one moment: the head is
 * read first, then the Gaps, and only Entries up to the head are passed, so that nothing
 * recorded while the read goes on is seen by half. A Gap recorded after the head is not
 * seen, and neither is the end of one, so its window stays open for this run.
 * @param source - Where the Log is read from.
 * @param target - The Target the soak sends to.
 * @returns What the pass kept.
 */
export const readLog = <E>(source: LogSource<E>, target: string) =>
  Effect.gen(function* () {
    const head = yield* source.head;

    if (head === null) {
      return yield* new LogUnavailable();
    }

    const pass = folder(target, boundedBy(head, yield* source.gaps));

    yield* pageStream(0, source.entries, ({ sequence }) => sequence).pipe(
      Stream.takeWhile(({ sequence }) => sequence <= head),
      Stream.runForEach((entry) =>
        Effect.sync(() => {
          pass.step(entry);
        })
      )
    );

    return pass.finish();
  });
