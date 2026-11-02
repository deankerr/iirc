import type { Entry } from "@iirc/session/entry";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { ReaderBusy, ReadFailed, ReadTimedOut } from "./errors.ts";
import { EntryRow, GapRow, MessageRow, Page } from "./rows.ts";

// Keyed by every tag an Entry can have, so a new kind of Entry cannot compile until it
// is filterable here too.
const entryKinds = {
  Change: "Change",
  Connection: "Connection",
  Daemon: "Daemon",
  Deadline: "Deadline",
  Dropped: "Dropped",
  Line: "Line",
} as const satisfies { readonly [Kind in Entry["_tag"]]: Kind };

// The kind of an Entry, which is its tag.
const EntryKind = Schema.Literals(Object.values(entryKinds));

/**
 * Which Entries to read, by cursor: from every Network unless `network` names one, and
 * of every kind unless `kinds` lists some.
 */
export const EntryQuery = Schema.Struct({
  ...Page.fields,
  kinds: Schema.optionalKey(Schema.NonEmptyArray(EntryKind)),
  network: Schema.optionalKey(Schema.String),
});

/** The decoded form of {@link EntryQuery}. */
export type EntryQuery = typeof EntryQuery.Type;

/** Which rows to read, by cursor, from every Network unless `network` names one. */
export const NetworkPage = Schema.Struct({
  ...Page.fields,
  network: Schema.optionalKey(Schema.String),
});

/** The decoded form of {@link NetworkPage}. */
export type NetworkPage = typeof NetworkPage.Type;

const error = Schema.Union([ReaderBusy, ReadFailed, ReadTimedOut]);

// When the read was sent, in epoch milliseconds, which both threads share, so the Worker
// can tell a read that waited too long in its queue to be worth running.
const queued = { queuedAt: Schema.Finite };

/** What crosses to the Worker for an `entries` read. */
const QueuedEntryQuery = Schema.Struct({ ...EntryQuery.fields, ...queued });

/** What crosses to the Worker for a read of Messages or Gaps. */
const QueuedNetworkPage = Schema.Struct({ ...NetworkPage.fields, ...queued });

/**
 * What the reader's Worker answers. It parses rows where it reads them, so what crosses
 * is what a row decodes to.
 */
export class ReaderRpcs extends RpcGroup.make(
  Rpc.make("entries", {
    error,
    payload: QueuedEntryQuery,
    success: Schema.Array(Schema.toType(EntryRow)),
  }),
  Rpc.make("messages", { error, payload: QueuedNetworkPage, success: Schema.Array(MessageRow) }),
  Rpc.make("gaps", {
    error,
    payload: QueuedNetworkPage,
    success: Schema.Array(Schema.toType(GapRow)),
  }),
  /**
   * Copies the Log into `into` and answers with the last sequence the copy holds (RUN-2).
   * It has no budget, because a copy takes as long as the Log is big, so only a Worker
   * started for it alone is asked, and the reads never queue behind it.
   */
  Rpc.make("backup", {
    error: ReadFailed,
    payload: Schema.Struct({ into: Schema.String }),
    success: Schema.Int,
  })
) {}

/**
 * What the reader's Worker needs before it can read: the database, each read's budget,
 * and how long a read may wait in its queue before it is not worth starting.
 */
export const ReaderStart = Schema.Struct({
  budgetMillis: Schema.Int,
  filename: Schema.String,
  queueMillis: Schema.Int,
});
