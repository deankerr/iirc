import { assert, describe, it } from "@effect/vitest";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { parseFrame } from "@iirc/protocol/line";
import { privmsg } from "@iirc/protocol/outbound";
import { Effect, Exit, Option, pipe, Stream } from "effect";
import type { Array as Arr } from "effect";

import type { Entry, NewEntry } from "./entry.ts";
import { constantNetwork, hostNetwork } from "./network.ts";
import type { NetworkHost, NetworkSettings } from "./network.ts";
import { Committed, InvalidWatchCapacity, maxWatchCapacity, Recorder } from "./recorder.ts";
import type { Watched } from "./recorder.ts";
import { fakeIrcd, movingClockWhileClosing } from "./testing.ts";
import { Transport } from "./transport.ts";

const deadline = (name: string): NewEntry => ({ _tag: "Deadline", name, network: "libera" });

const record = (entries: Arr.NonEmptyReadonlyArray<NewEntry>) =>
  Recorder.use(({ record }) => Effect.asVoid(record(entries, (recorded) => recorded)));

const watch = (capacity?: number) =>
  Committed.use(({ watch }) => watch(capacity === undefined ? undefined : { capacity }));

// What a watch gave, as a sequence for each Entry and a range for each miss.
const brief = (watched: readonly Watched[]) =>
  watched.map((item) =>
    item._tag === "Overflowed" ? `missed ${item.missedFrom}-${item.missedTo}` : item.sequence
  );

describe("Committed, over the memory Recorder", () => {
  it.effect("gives Entries in sequence order, across commits", () =>
    Effect.gen(function* () {
      const stream = yield* Effect.scoped(
        Effect.gen(function* () {
          const watched = yield* watch();

          yield* record([deadline("a"), deadline("b")]);
          yield* record([deadline("c")]);

          return watched;
        })
      );

      assert.deepStrictEqual(brief(yield* Stream.runCollect(stream)), [1, 2, 3]);
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("gives only what commits after `watch` returns, even before the Stream runs", () =>
    Effect.gen(function* () {
      yield* record([deadline("before")]);

      const stream = yield* Effect.scoped(
        Effect.gen(function* () {
          const watched = yield* watch();

          yield* record([deadline("after")]);

          return watched;
        })
      );

      const entries = yield* Stream.runCollect(stream);

      assert.deepStrictEqual(brief(entries), [2]);
      assert.strictEqual(entries[0]?._tag === "Deadline" && entries[0].name, "after");
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("gives nothing a rolled-back `record` numbered", () =>
    Effect.gen(function* () {
      const stream = yield* Effect.scoped(
        Effect.gen(function* () {
          const watched = yield* watch();

          const rolledBack = yield* Effect.exit(
            Recorder.use(({ record }) =>
              record([deadline("lost")], () => {
                throw new Error("rolled back");
              })
            )
          );

          assert.isTrue(Exit.isFailure(rolledBack));
          yield* record([deadline("kept")]);

          return watched;
        })
      );

      const entries = yield* Stream.runCollect(stream);

      assert.deepStrictEqual(brief(entries), [1]);
      assert.strictEqual(entries[0]?._tag === "Deadline" && entries[0].name, "kept");
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("says which run a slow watcher missed, in its place, and goes on after it", () =>
    Effect.gen(function* () {
      const stream = yield* Effect.scoped(
        Effect.gen(function* () {
          const slow = yield* watch(2);
          const quick = yield* watch();

          yield* record([deadline("1"), deadline("2"), deadline("3"), deadline("4")]);
          // Still missing, because it has not taken what it holds.
          yield* record([deadline("5")]);

          const taken = yield* slow.pipe(Stream.take(3), Stream.runCollect);

          assert.deepStrictEqual(brief(taken), [1, 2, "missed 3-5"]);
          // The other watcher was not held to the slow one's limit.
          assert.deepStrictEqual(
            brief(yield* quick.pipe(Stream.take(5), Stream.runCollect)),
            [1, 2, 3, 4, 5]
          );

          yield* record([deadline("6")]);

          return slow;
        })
      );

      assert.deepStrictEqual(brief(yield* Stream.runCollect(stream)), [6]);
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("refuses a capacity that would bound nothing, and takes the ends of the range", () =>
    Effect.gen(function* () {
      for (const capacity of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        maxWatchCapacity + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const exit = yield* Effect.exit(Effect.scoped(watch(capacity)));

        assert.deepStrictEqual(
          Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag),
          ["Fail"]
        );
        assert.isTrue(
          Exit.isFailure(exit) &&
            exit.cause.reasons.every(
              (reason) =>
                reason._tag === "Fail" &&
                reason.error instanceof InvalidWatchCapacity &&
                Object.is(reason.error.capacity, capacity)
            )
        );
      }

      for (const capacity of [1, maxWatchCapacity]) {
        yield* Effect.asVoid(Effect.scoped(watch(capacity)));
      }
    }).pipe(Effect.provide(Recorder.memory))
  );

  it.effect("never holds up a commit, however far behind a watcher is", () =>
    Effect.gen(function* () {
      const stream = yield* Effect.scoped(
        Effect.gen(function* () {
          const watched = yield* watch(1);

          for (let index = 0; index < 100; index += 1) {
            yield* record([deadline(String(index))]);
          }

          return watched;
        })
      );

      assert.deepStrictEqual(brief(yield* Stream.runCollect(stream)), [1, "missed 2-100"]);
    }).pipe(Effect.provide(Recorder.memory))
  );
});

// A bot as a library user would write it, with nothing but `hostNetwork` and a watch: it
// answers `!ping <token>` from anyone with `pong <token>`.
const answerPings = (network: NetworkHost, watched: Stream.Stream<Watched>) =>
  Stream.runForEach(watched, (item) => {
    if (item._tag === "Overflowed") {
      return Effect.logWarning(`missed Entries ${item.missedFrom} to ${item.missedTo}`);
    }

    if (item._tag !== "Line" || item.direction !== "inbound") {
      return Effect.void;
    }

    const parsed = parseFrame(item.bytes);

    if (parsed._tag !== "Line" || parsed.line.command !== "PRIVMSG") {
      return Effect.void;
    }

    const [, text = ""] = parsed.line.params;
    const sender = parsed.line.source?.split("!")[0];

    if (sender === undefined || !text.startsWith("!ping ")) {
      return Effect.void;
    }

    const reply = privmsg(sender, `pong ${text.slice("!ping ".length)}`);

    return reply._tag === "Safe"
      ? Effect.ignore(network.send(reply.line, "ping-bot"))
      : Effect.logWarning(`cannot answer ${sender}: ${reply.reason}`);
  });

const settings: NetworkSettings = {
  channels: [],
  connectCommands: [],
  credentials: {},
  enabled: true,
  identity: { alternates: [], nick: "bot", realname: "A bot", username: "bot" },
  ircds: [{ host: "irc.test", port: 6697, tls: true }],
  quitReason: "bye",
  secrets: new Map(),
  services: [],
  tuning: defaultTuning,
};

const isOutboundPrivmsg = (item: Watched): item is Extract<Entry, { _tag: "Line" }> =>
  item._tag === "Line" &&
  item.direction === "outbound" &&
  new TextDecoder().decode(item.bytes).startsWith("PRIVMSG");

describe("a bot on `hostNetwork`", () => {
  it.effect("answers a `!ping` with only the host and a watch", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { watch } = yield* Committed;

      // Each watch sees what commits after it subscribes, so all three come first.
      const forBot = yield* watch();
      const opened = yield* watch();
      const replies = yield* watch();

      const network = yield* movingClockWhileClosing(
        hostNetwork(constantNetwork("libera", settings)).pipe(
          Effect.provideService(Transport, ircd.transport)
        )
      );

      yield* Effect.forkScoped(answerPings(network, forBot));

      yield* opened.pipe(
        Stream.filter((item) => item._tag === "Connection" && item.phase === "opened"),
        Stream.runHead
      );

      yield* ircd.read(":ircd 001 bot :Welcome\r\n", ":alice!a@example PRIVMSG bot :!ping 42\r\n");

      const reply = yield* replies.pipe(Stream.filter(isOutboundPrivmsg), Stream.runHead);

      assert.deepStrictEqual(
        pipe(
          reply,
          Option.map(({ bytes, cause }) => ({ cause, text: new TextDecoder().decode(bytes) }))
        ),
        Option.some({ cause: "ping-bot", text: "PRIVMSG alice :pong 42" })
      );
    }).pipe(Effect.provide(Recorder.memory))
  );
});
