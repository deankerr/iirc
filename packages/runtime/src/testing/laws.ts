/**
 * Contract tests for the ports, as data. Every adapter of a port runs that port's laws,
 * so the in-memory adapters and the durable ones agree. A law is an Effect that fails
 * with {@link LawBroken}, so this module needs no test runner.
 *
 * @packageDocumentation
 */
import { ConnectionId, Input, Instant, Output } from "@iirc/client";
import { CredentialName, OutboundLine } from "@iirc/protocol/line";
import { Effect, Fiber, Redacted, Schema, Stream } from "effect";
import type { Scope } from "effect";

import { JournalRecord, NetworkId, Sequence } from "../journal.ts";
import type { JournalFailed, JournalService } from "../journal.ts";
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
const showSequences = (sequences: readonly Sequence[]) => sequences.join(",");

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
  JournalRecord.cases.Unfilled.make({
    credential: CredentialName.make("libera-password"),
    network: libera,
    of: Sequence.make(1),
  }),
];

const appendAll = (journal: JournalService, all: readonly JournalRecord[]) =>
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes the iterable first; it has no thisArg.
  Effect.forEach(all, (record) => journal.append(record));

const collect = <A, E>(stream: Stream.Stream<A, E>) => Stream.runCollect(stream);

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
        const before = yield* appendAll(journal, records.slice(0, 2));

        const following = yield* Effect.forkScoped(
          collect(Stream.take(journal.follow({}), records.length))
        );

        const later = yield* appendAll(journal, records.slice(2));
        const followed = yield* Fiber.join(following);

        yield* same(
          "sequences",
          showSequences(followed.map((e) => e.sequence)),
          showSequences([...before, ...later])
        );
        yield* same("records", showRecords(followed.map((e) => e.record)), showRecords(records));
      }),
    name: "follows the past and then each new Entry, once each, in order",
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
];
