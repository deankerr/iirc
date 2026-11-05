import { readFileSync } from "node:fs";

import { phase } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { pipe, Record, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { Entry } from "./entry.ts";
import {
  consecutiveFailures,
  foldStandings,
  joinPlan,
  loginOf,
  nextAttempt,
  noStandings,
  sessionSince,
} from "./standing.ts";
import type { Standing } from "./standing.ts";

// Logs that hosts wrote, each taken whole from what a test of this package recorded before
// the machine became the only owner of a Connection's progress, with every read of Standing
// at every Entry as the code of the time gave it. The last two were written to cover
// Channels, kicks, keys, and `RPL_ISUPPORT`, with their reads as the code gave them before
// `@iirc/state` owned those. A Log already written is replayed by whatever code reads it
// later, so the reads must not move. One Log to a line, and bytes in base64. The two Logs
// that end refused were moved once, on purpose: refusals went, so their last read has no
// `refusal`, and its next attempt is ordinary backoff (LIVE-5).
const fixture = new URL("testdata/replay.jsonl", import.meta.url);

const Moment = { at: Schema.Finite, sequence: Schema.Finite };

const Ircd = Schema.Struct({
  host: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  port: Schema.Finite,
  tls: Schema.Boolean,
});

const Tuning = Schema.Struct(
  pipe(
    defaultTuning,
    Record.map(() => Schema.Finite)
  )
);

const ToNetwork = { ircd: Ircd, network: Schema.String };

const RecordedEntry = Schema.Union([
  Schema.TaggedStruct("Line", {
    ...Moment,
    bytes: Schema.Uint8ArrayFromBase64,
    cause: Schema.optionalKey(Schema.String),
    connection: Schema.Finite,
    cut: Schema.optionalKey(Schema.Boolean),
    direction: Schema.Literals(["inbound", "outbound"]),
    network: Schema.String,
    redacted: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.TaggedStruct("Connection", {
    ...Moment,
    ...ToNetwork,
    loginLines: Schema.Finite,
    nicks: Schema.Array(Schema.String),
    phase: Schema.Literal("attempt"),
    realname: Schema.String,
    services: Schema.Array(Schema.String),
    tuning: Tuning,
    username: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...Moment,
    ...ToNetwork,
    connection: Schema.Finite,
    phase: Schema.Literal("opened"),
  }),
  Schema.TaggedStruct("Connection", {
    ...Moment,
    ...ToNetwork,
    chosen: Schema.Boolean,
    connection: Schema.Finite,
    phase: Schema.Literal("closing"),
    reason: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...Moment,
    ...ToNetwork,
    connection: Schema.Finite,
    endedAt: Schema.optionalKey(Schema.Finite),
    phase: Schema.Literal("closed"),
    reason: Schema.optionalKey(Schema.String),
    refused: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Dropped", {
    ...Moment,
    bytes: Schema.Uint8ArrayFromBase64,
    cause: Schema.String,
    connection: Schema.Finite,
    network: Schema.String,
    reason: Schema.String,
    redacted: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.TaggedStruct("Deadline", { ...Moment, name: Schema.String, network: Schema.String }),
  Schema.TaggedStruct("Daemon", {
    ...Moment,
    phase: Schema.Literals(["started", "stopped"]),
    version: Schema.String,
  }),
]);

// What the reads were, kept as JSON, with each read as a record so one field can be named.
const Replayed = Schema.Struct({
  gaps: Schema.Array(Schema.Json),
  reads: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Record(Schema.String, Schema.Json)])),
});

type Replayed = typeof Replayed.Type;

const RecordedLog = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(RecordedEntry),
    expected: Replayed,
    name: Schema.String,
  })
);

const recorded = readFileSync(fixture, "utf-8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => Schema.decodeSync(RecordedLog)(line));

// Everything the Daemon reads of a Standing, as plain data: what the hosts decide by, what
// status shows, and what the derived tables are written from. Channels are read as status
// reads them, by name in order, because how Standing holds them is its own business.
const readsOf = (standing: Standing, now: number) => {
  const { attempt, connection } = standing;
  const joined = [...standing.irc.channels.values()].map(({ name }) => name);

  const wanted = [
    ...new Set([
      "#iirc",
      ...joined,
      ...standing.asked.keys(),
      ...standing.kicked.keys(),
      ...standing.joinFailures.keys(),
    ]),
  ].map((name, index) => ({ name, rejoinOnKick: index % 2 === 1 }));

  return {
    asked: [...standing.asked],
    attempt,
    channels: joined,
    connection:
      connection === undefined
        ? undefined
        : {
            closing: connection.closing,
            last: connection.last,
            network: connection.network,
            sequence: connection.sequence,
          },
    failures: consecutiveFailures(standing, defaultTuning, now),
    gap: standing.gap,
    joinFailures: [...standing.joinFailures],
    kicked: [...standing.kicked],
    lagChecks: standing.lagChecks,
    lagMillis: standing.lagMillis,
    login: loginOf(standing),
    network: standing.network,
    next:
      attempt === undefined
        ? undefined
        : nextAttempt(standing, { ircds: [attempt.ircd], tuning: defaultTuning }),
    nickLength: standing.nickLength,
    plan: joinPlan(standing, wanted, now, defaultTuning),
    recent: standing.recent,
    self: standing.irc.self,
    since: sessionSince(standing),
  };
};

// The one way a replay now differs, and on purpose. Once the machine has given up on a
// Session, on an `ERROR` or on silence, nothing is planned to join. These Logs were written
// when Standing went on planning until the `closing` Entry was recorded, which the lanes the
// close had shut refused, so no Line came of it and nothing derived from it.
const hasGivenUp = ({ connection }: Standing) =>
  connection !== undefined &&
  connection.closing === undefined &&
  phase(connection.machine) === "closing";

const nothingPlanned = { channels: [] };

// Every read at every Entry, and every Gap as it was written, through JSON so that what is
// compared is what the fixture can hold. `givenUp` is where the machine had given up.
const replay = (entries: readonly Entry[]) => {
  const reads: unknown[] = [];
  const gaps: unknown[] = [];
  const givenUp = new Set<number>();

  foldStandings(noStandings, entries, ({ after, before, entry }) => {
    reads.push([entry.sequence, readsOf(after, entry.at)]);

    if (hasGivenUp(after)) {
      givenUp.add(entry.sequence);
    }

    if (after.gap !== undefined && after.gap !== before.gap) {
      gaps.push(after.gap);
    }
  });

  const replayed = Schema.decodeSync(Schema.fromJsonString(Replayed))(
    JSON.stringify({ gaps, reads })
  );

  return { givenUp, replayed };
};

// What the fixture says, with nothing planned wherever the machine had given up.
const asNow = (expected: Replayed, givenUp: ReadonlySet<number>): Replayed => ({
  ...expected,
  reads: expected.reads.map(([sequence, read]) =>
    givenUp.has(sequence) ? [sequence, { ...read, plan: nothingPlanned }] : [sequence, read]
  ),
});

describe("LOG-10: a Log already written replays as it did", () => {
  it.each(recorded)("LOG-10: $name", ({ entries, expected }) => {
    const { givenUp, replayed } = replay(entries);

    expect(replayed).toStrictEqual(asNow(expected, givenUp));
  });

  it("LIVE-11: the one difference is there to be seen, after silence", () => {
    const silence = recorded.find(({ name }) => name === "silence");

    expect([...replay(silence?.entries ?? []).givenUp]).toStrictEqual([7]);
  });
});
