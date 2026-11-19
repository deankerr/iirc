// Folds a Message a step into a new store, in a process of its own, since SQLite reads its
// temporary directory once per process. Prints how far the store folded, or why it stopped.
// Usage: bun fold-messages.fixture.ts <file> <steps>
import { BunFileSystem } from "@effect/platform-bun";
import { Instant } from "@iirc/client";
import { emptyDirectory, timelineIdOf } from "@iirc/timelines";
import type { Change } from "@iirc/timelines";
import { Effect, Layer, Logger } from "effect";

import { makeSqliteTimelineStore } from "./sqlite-timeline-store.ts";

const [file = "", steps = "0"] = process.argv.slice(2);
const network = "libera";
const channel = timelineIdOf(1, 0, 1);
const at = (sequence: number) => Instant.make(1_762_560_000_000 + sequence);

const heard = (sequence: number): Change => ({
  _tag: "Added",
  content: {
    _tag: "Message",
    answers: undefined,
    at: { _tag: "Known", at: at(sequence), from: "ircd", value: at(sequence) },
    context: undefined,
    id: { _tag: "Unknown" },
    kind: "Privmsg",
    live: true,
    ours: undefined,
    sender: "peer",
    tags: [],
    target: "#a",
    text: `message ${sequence}`,
  },
  ignored: [],
  intent: undefined,
  level: "Message",
  messageId: undefined,
  network,
  position: { at: at(sequence), n: 0, sequence },
  sequence,
  timeline: channel,
});

const fold = Effect.gen(function* () {
  const store = yield* makeSqliteTimelineStore(file);

  yield* store.reset(1);
  yield* store.apply({
    changes: [
      {
        _tag: "Described",
        sequence: 1,
        timeline: { id: channel, key: "#a", kind: "Channel", life: 1, name: "#a", network },
      },
    ],
    directory: emptyDirectory,
    through: 1,
  });

  for (let sequence = 2; sequence <= Number(steps); sequence += 1) {
    yield* store.apply({
      changes: [heard(sequence)],
      directory: emptyDirectory,
      through: sequence,
    });
  }

  return yield* store.folded;
});

const result = await Effect.runPromise(
  Effect.scoped(fold).pipe(
    Effect.map(({ through }) => ({ through })),
    Effect.catch((error) => Effect.succeed({ reason: error.reason })),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, Logger.layer([])))
  )
);

process.stdout.write(JSON.stringify(result));
