import { assert, describe, it } from "@effect/vitest";
import { parseLine } from "@iirc/protocol/line";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { lifecycle } from "./lifecycle.ts";

const line = (text: string) => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    throw new Error(`Expected a Line from ${text}`);
  }

  return parsed.line;
};

describe("connection lifecycle", () => {
  it.effect("gives up on a registration that never completes", () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(lifecycle);
      yield* send(actor, { type: "OPENED" });
      yield* waitFor(actor, (snapshot) => snapshot.matches("registering"));

      yield* TestClock.adjust("30 seconds");

      const snapshot = yield* waitFor(actor, (current) => current.matches("closed"));
      assert.strictEqual(snapshot.context.closeReason, "Registration timed out");
    }).pipe(Effect.scoped)
  );

  it.effect("closes when the nick is taken", () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(lifecycle);
      yield* send(actor, { type: "OPENED" });
      yield* send(actor, {
        line: line(":ircd 433 * claude :Nickname is already in use"),
        type: "LINE",
      });

      const snapshot = yield* waitFor(actor, (current) => current.matches("closed"));
      assert.strictEqual(snapshot.context.closeReason, "Nick claude is already in use");
    }).pipe(Effect.scoped)
  );

  it.effect("ignores a nick error once registered", () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(lifecycle);
      yield* send(actor, { type: "OPENED" });
      yield* send(actor, { line: line(":ircd 001 claude :Welcome"), type: "LINE" });
      yield* send(actor, { line: line(":ircd 433 claude other :in use"), type: "LINE" });
      yield* send(actor, { line: line("ERROR :Closing Link"), type: "LINE" });

      const snapshot = yield* waitFor(actor, (current) => current.matches("closed"));
      assert.strictEqual(
        snapshot.context.closeReason,
        "The Ircd closed the Connection: Closing Link"
      );
    }).pipe(Effect.scoped)
  );
});
