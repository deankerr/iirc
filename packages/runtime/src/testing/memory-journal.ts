import { Effect, PubSub, Ref, Schema, Semaphore, Stream } from "effect";

import { Entry, Sequence } from "../journal.ts";
import type { JournalService, Position } from "../journal.ts";

const codec = Schema.fromJsonString(Schema.toCodecJson(Entry));
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeSync(codec);

const matches = (from: Position) => (entry: Entry) =>
  entry.sequence > (from.after ?? 0) &&
  (from.network === undefined || entry.record.network === from.network);

/**
 * A Journal in memory. It stores each Entry's JSON encoding, as a durable adapter does,
 * so a record that cannot be stored fails here too.
 * @returns A fresh, empty Journal.
 */
export const makeMemoryJournal: Effect.Effect<JournalService> = Effect.gen(function* () {
  const stored = yield* Ref.make<readonly string[]>([]);
  const appended = yield* PubSub.unbounded<Entry>();
  const lock = yield* Semaphore.make(1);

  const entries = Ref.get(stored).pipe(Effect.map((texts) => texts.map((text) => decode(text))));

  return {
    // One append at a time, so Entries are published in the order they are numbered.
    // Storing and publishing cannot be interrupted apart, or a follower would miss an Entry.
    append: (record) =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const entry = yield* Ref.modify(stored, (texts) => {
              const text = encode({ record, sequence: Sequence.make(texts.length + 1) });

              return [decode(text), [...texts, text]] as const;
            });

            yield* PubSub.publish(appended, entry);

            return entry.sequence;
          })
        )
      ),
    follow: (from) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the past, so nothing appended in between is missed.
          const live = yield* PubSub.subscribe(appended);
          const past = yield* entries;
          const last = past.at(-1)?.sequence ?? 0;

          return Stream.concat(
            Stream.fromIterable(past.filter(matches(from))),
            Stream.fromSubscription(live).pipe(
              Stream.filter((entry) => entry.sequence > last && matches(from)(entry))
            )
          );
        })
      ),
    read: (from) =>
      Stream.unwrap(
        entries.pipe(Effect.map((past) => Stream.fromIterable(past.filter(matches(from)))))
      ),
  };
});
