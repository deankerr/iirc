/**
 * Contract tests for the ports, as data. Every adapter of a port runs that port's laws,
 * so the in-memory adapters and the durable ones agree. A law is an Effect that fails
 * with {@link LawBroken}, so this module needs no test runner.
 *
 * @packageDocumentation
 */
import { ConnectionId, Input, Instant, Output } from "@iirc/client";
import { CredentialName, OutboundLine } from "@iirc/protocol/line";
import { Deferred, Effect, Fiber, Redacted, Ref, Scheduler, Schema, Stream } from "effect";
import type { Scope } from "effect";

import { Entry, JournalRecord, NetworkId, Sequence } from "../journal.ts";
import type { JournalFailed, JournalService, Position } from "../journal.ts";
import { maxReceivedBytes } from "../transport.ts";
import type { LinkEvent, TransportService } from "../transport.ts";
import type { CredentialMissing, VaultFailed, VaultService } from "../vault.ts";
import type { TestIrcd } from "./memory-transport.ts";

/** A law did not hold. */
export class LawBroken extends Schema.TaggedError<LawBroken, { readonly brand: unique symbol }>()(
  "LawBroken",
  {
    actual: Schema.String,
    expected: Schema.String,
    what: Schema.String,
  }
) {}

/** One law, checked against a fresh harness. */
export interface Law<Harness, E> {
  readonly name: string;
  readonly check: (harness: Harness) => Effect.Effect<void, E | LawBroken, Scope.Scope>;
}

/**
 * Checks one law against a fresh harness, in its own Scope. A law that waits for
 * something that never comes fails after two seconds rather than hanging.
 * @param law - The law to check.
 * @param make - Makes a fresh harness.
 * @returns An Effect that succeeds if the law holds.
 */
export const holds = <Harness, E, M>(
  law: Law<Harness, E>,
  make: Effect.Effect<Harness, M, Scope.Scope>
) =>
  make.pipe(
    Effect.flatMap(law.check),
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () =>
        Effect.fail(
          new LawBroken({
            actual: "nothing yet",
            expected: "done",
            what: `${law.name}, within two seconds`,
          })
        ),
    })
  );

const same = (what: string, actual: string, expected: string) =>
  actual === expected ? Effect.void : Effect.fail(new LawBroken({ actual, expected, what }));

const text = new TextDecoder();
const bytes = new TextEncoder();

const recordJson = Schema.encodeSync(Schema.toCodecJson(Schema.Array(JournalRecord)));
const showRecords = (records: readonly JournalRecord[]) => JSON.stringify(recordJson(records));

const at = Instant.make(1_762_560_000_000);
const connection = ConnectionId.make(1);
const libera = NetworkId.make("libera");
const oftc = NetworkId.make("oftc");

const records: readonly JournalRecord[] = [
  JournalRecord.cases.Input.make({ input: Input.cases.Started.make({ at }), network: libera }),
  JournalRecord.cases.Input.make({
    input: Input.cases.Received.make({
      at,
      bytes: bytes.encode(":irc.test 001 iirc :hi"),
      connection,
    }),
    network: oftc,
  }),
  JournalRecord.cases.Outputs.make({
    network: libera,
    of: Sequence.make(1),
    outputs: [
      Output.cases.Send.make({
        connection,
        line: OutboundLine.make({ command: "CAP", params: ["REQ", "sasl"], tags: {} }),
      }),
      Output.cases.SendSecret.make({
        connection,
        line: { _tag: "Pass", credential: CredentialName.make("libera-password") },
      }),
    ],
  }),
  JournalRecord.cases.Input.make({
    input: Input.cases.Unfilled.make({
      at,
      connection,
      line: { _tag: "Pass", credential: CredentialName.make("libera-password") },
      reason: "Missing",
    }),
    network: libera,
  }),
];

const inOrder = <A, B, E, R>(
  items: Iterable<A>,
  f: (item: A, index: number) => Effect.Effect<B, E, R>
) =>
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
  Effect.forEach(items, f);

const atOnce = <A, B, E, R>(items: Iterable<A>, f: (item: A) => Effect.Effect<B, E, R>) =>
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
  Effect.forEach(items, f, { concurrency: "unbounded" });

const appendAll = (journal: JournalService, all: readonly JournalRecord[]) =>
  inOrder(all, (record) => journal.append(record));

const entryJson = Schema.encodeSync(Schema.toCodecJson(Schema.Array(Entry)));
const showEntries = (entries: readonly Entry[]) => JSON.stringify(entryJson(entries));

const collect = <A, E>(stream: Stream.Stream<A, E>) => Stream.runCollect(stream);

const sentinel = JournalRecord.cases.Input.make({
  input: Input.cases.Retry.make({ at }),
  network: libera,
});

/** A follower started in the background, and a signal that it has had the past. */
interface Follower {
  readonly caughtUp: Deferred.Deferred<undefined>;
  readonly seen: Ref.Ref<readonly Entry[]>;
}

const following = (journal: JournalService, from: Position) =>
  Effect.gen(function* () {
    const past = (yield* collect(journal.read(from))).length;
    const caughtUp = yield* Deferred.make<undefined>();
    const seen = yield* Ref.make<readonly Entry[]>([]);

    if (past === 0) {
      yield* Deferred.succeed(caughtUp, undefined);
    }

    yield* Effect.forkScoped(
      Stream.runForEach(journal.follow(from), (entry) =>
        Ref.updateAndGet(seen, (entries) => [...entries, entry]).pipe(
          Effect.flatMap((entries) =>
            entries.length === past ? Deferred.succeed(caughtUp, undefined) : Effect.void
          )
        )
      )
    );

    return { caughtUp, seen } satisfies Follower;
  });

// Waits until the follower has seen as many Entries as a read gives, then compares them.
const agrees = (journal: JournalService, from: Position, follower: Follower) =>
  Effect.gen(function* () {
    const expected = yield* collect(journal.read(from));
    let seen = yield* Ref.get(follower.seen);

    while (seen.length < expected.length) {
      yield* Effect.sleep("1 millis");
      seen = yield* Ref.get(follower.seen);
    }

    yield* same("followed", showEntries(seen), showEntries(expected));
  });

/** The laws every Journal adapter keeps. */
export const journalLaws: readonly Law<JournalService, JournalFailed>[] = [
  {
    check: (journal) =>
      Effect.gen(function* () {
        const sequences = yield* appendAll(journal, records);
        const increasing = sequences.every((s, i) => i === 0 || s > (sequences[i - 1] ?? 0));

        yield* same("sequences increase", String(increasing), "true");
      }),
    name: "numbers Entries in the order they are appended",
  },
  {
    check: (journal) =>
      Effect.gen(function* () {
        yield* appendAll(journal, records);
        const entries = yield* collect(journal.read({}));

        yield* same("records", showRecords(entries.map((e) => e.record)), showRecords(records));
      }),
    name: "reads back exactly what was appended, bytes and secret Lines included",
  },
  {
    check: (journal) =>
      Effect.gen(function* () {
        const [first] = yield* appendAll(journal, records);
        const after = yield* collect(journal.read({ after: first }));
        const forOftc = yield* collect(journal.read({ network: oftc }));

        yield* same(
          "after the first",
          showRecords(after.map((e) => e.record)),
          showRecords(records.slice(1))
        );
        yield* same(
          "for one Network",
          showRecords(forOftc.map((e) => e.record)),
          showRecords(records.slice(1, 2))
        );
      }),
    name: "reads after a position, and for one Network",
  },
  {
    check: (journal) =>
      Effect.gen(function* () {
        const [first] = yield* appendAll(journal, records.slice(0, 2));
        const positions: readonly Position[] = [{}, { network: oftc }, { after: first }];
        const followers = yield* inOrder(positions, (from) => following(journal, from));

        // Every follower has had the past before anything new is appended, and the new
        // Entries are appended concurrently.
        yield* inOrder(followers, (follower) => Deferred.await(follower.caughtUp));
        yield* atOnce(records.slice(2), (record) => journal.append(record));
        yield* inOrder(followers, (follower, i) => agrees(journal, positions[i] ?? {}, follower));
      }),
    name: "follows the past and then each new Entry, once each, in order",
  },
  {
    check: (journal) =>
      Effect.gen(function* () {
        const follower = yield* following(journal, {});

        yield* Deferred.await(follower.caughtUp);

        // Interrupt appends at every point between two operations, by making the scheduler
        // yield every few operations. Each is kept and followed, or not kept at all. A
        // budget below 3 livelocks Effect 4.1.1's scheduler.
        yield* inOrder(
          Array.from({ length: 40 }, (_, steps) => steps),
          (steps) =>
            Effect.gen(function* () {
              const appending = yield* Effect.forkChild(journal.append(sentinel));

              for (let step = 0; step < steps; step += 1) {
                yield* Effect.yieldNow;
              }

              yield* Fiber.interrupt(appending);
            }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
        );

        yield* journal.append(records[0] ?? sentinel);
        yield* agrees(journal, {}, follower);
      }),
    name: "keeps an interrupted append whole, or not at all",
  },
];

const credential = CredentialName.make("libera-password");

// What revealing the law's Credential gives: the error and its name, or `held`.
const missingOf = (vault: VaultService) =>
  vault.reveal(credential).pipe(
    Effect.match({
      onFailure: (error) =>
        error._tag === "CredentialMissing" ? `${error._tag} ${error.credential}` : error._tag,
      onSuccess: () => "held",
    })
  );

/** The laws every Vault adapter keeps, starting empty. */
export const vaultLaws: readonly Law<VaultService, CredentialMissing | VaultFailed>[] = [
  {
    check: (vault) =>
      Effect.gen(function* () {
        yield* vault.hold(credential, Redacted.make("hunter2"));
        const value = yield* vault.reveal(credential);

        yield* same("value", Redacted.value(value), "hunter2");
      }),
    name: "gives back the value it holds",
  },
  {
    check: (vault) =>
      Effect.gen(function* () {
        yield* same("missing", yield* missingOf(vault), `CredentialMissing ${credential}`);
      }),
    name: "says which Credential it does not hold",
  },
  {
    check: (vault) =>
      Effect.gen(function* () {
        yield* vault.hold(credential, Redacted.make("old"));
        yield* vault.hold(credential, Redacted.make("new"));
        const value = yield* vault.reveal(credential);

        yield* same("replaced", Redacted.value(value), "new");
        yield* vault.forget(credential);
        yield* vault.forget(credential);
        yield* same("forgotten", yield* missingOf(vault), `CredentialMissing ${credential}`);
      }),
    name: "replaces a value, and forgets one",
  },
  {
    check: (vault) =>
      Effect.gen(function* () {
        yield* vault.hold(credential, Redacted.make("hunter2"));
        const names = yield* vault.names;
        const value = yield* vault.reveal(credential);
        const shown = `${JSON.stringify(value)} ${[...names].join(",")}`;

        yield* same("names", [...names].join(","), credential);
        yield* same("redacted", String(Redacted.isRedacted(value)), "true");
        yield* same("value hidden", String(shown.includes("hunter2")), "false");
      }),
    name: "lists names, and never shows a value",
  },
];

/** A Transport, and the far end of it for the laws to play. */
export interface TransportHarness {
  readonly transport: TransportService;
  readonly ircd: TestIrcd;
}

const address = { host: "irc.test", port: 6697, tls: true };

const showEvent = (event: LinkEvent) => {
  if (event._tag === "Received") {
    return `Received ${text.decode(event.bytes)}`;
  }

  if (event._tag === "Closed") {
    return `Closed ${event.reason}`;
  }

  return event._tag;
};

const showEvents = (events: readonly LinkEvent[]) => events.map(showEvent).join(" | ");

/** The laws every Transport adapter keeps. */
export const transportLaws: readonly Law<TransportHarness, never>[] = [
  {
    check: ({ ircd, transport }) =>
      Effect.gen(function* () {
        const link = yield* transport.dial(address);
        const call = yield* ircd.accept;

        yield* call.open;
        yield* call.say(bytes.encode(":irc.test NOTICE * :one"));
        yield* call.say(bytes.encode(":irc.test NOTICE * :two"));
        yield* call.close("Ended");
        const events = yield* collect(link.events);

        yield* same(
          "events",
          showEvents(events),
          "Opened | Received :irc.test NOTICE * :one | Received :irc.test NOTICE * :two | Closed Ended"
        );
      }),
    name: "reports Opened, then each Line, then Closed once, and ends",
  },
  {
    check: ({ ircd, transport }) =>
      Effect.gen(function* () {
        const link = yield* transport.dial(address);
        const call = yield* ircd.accept;

        yield* call.open;
        yield* link.send(bytes.encode("CAP LS 302\r\n"));
        const heard = yield* call.heard;

        yield* same("heard", text.decode(heard), "CAP LS 302\r\n");
      }),
    name: "carries Lines to the Ircd as they were sent",
  },
  {
    check: ({ ircd, transport }) =>
      Effect.gen(function* () {
        const link = yield* transport.dial(address);
        const call = yield* ircd.accept;

        yield* call.open;
        yield* link.hangup;
        yield* call.close("Reset");
        yield* link.send(bytes.encode("QUIT\r\n"));
        const events = yield* collect(link.events);

        yield* same("events", showEvents(events), "Opened | Closed HungUp");
      }),
    name: "ends with HungUp when asked, and ignores anything after",
  },
  {
    check: ({ ircd, transport }) =>
      Effect.gen(function* () {
        const link = yield* transport.dial(address);
        const call = yield* ircd.accept;

        yield* call.close("Refused");
        const events = yield* collect(link.events);

        yield* same("events", showEvents(events), "Closed Refused");
      }),
    name: "reports a dial that fails as Closed, with no Opened",
  },
  {
    check: ({ ircd, transport }) =>
      Effect.gen(function* () {
        const link = yield* transport.dial(address);
        const call = yield* ircd.accept;

        yield* call.open;
        yield* call.say(new Uint8Array());
        yield* call.say(bytes.encode("PING :x"));
        yield* call.close("Ended");
        const events = yield* collect(link.events);

        yield* same("events", showEvents(events), "Opened | Received PING :x | Closed Ended");
      }),
    name: "skips an empty Line",
  },
  {
    check: ({ ircd, transport }) =>
      Effect.gen(function* () {
        const link = yield* transport.dial(address);
        const call = yield* ircd.accept;
        const long = bytes.encode(`:irc.test NOTICE * :${"x".repeat(maxReceivedBytes)}`);

        yield* call.open;
        yield* call.say(long);
        yield* call.close("Ended");
        const events = yield* collect(link.events);
        const lengths = events.map((event) => (event._tag === "Received" ? event.bytes.length : 0));
        const cut = events.find((event) => event._tag === "Received");

        yield* same("lengths", lengths.join(","), `0,${maxReceivedBytes},0`);
        yield* same(
          "start kept",
          cut?._tag === "Received" ? text.decode(cut.bytes.slice(0, 20)) : "",
          text.decode(long.slice(0, 20))
        );
      }),
    name: "cuts a Line longer than maxReceivedBytes, keeping its start",
  },
];
