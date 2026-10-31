import { BunSocket } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { privmsg } from "@iirc/protocol/outbound";
import { Effect, Ref } from "effect";

import type { Observation } from "./session.ts";
import { makeSession } from "./session.ts";
import { eventually, scriptedIrcd, welcoming } from "./testing.ts";

const start = Effect.fn("start")(function* (port: number) {
  const observed = yield* Ref.make<readonly Observation[]>([]);

  const session = yield* makeSession({
    channels: ["#iirc"],
    nick: "claude",
    observe: (observation) => Ref.update(observed, (all) => [...all, observation]),
    realname: "Claude",
    socket: yield* BunSocket.makeNet({ host: "127.0.0.1", port }),
    username: "claude",
  });

  return { observed, session };
});

describe(makeSession, () => {
  it.live("registers without any CAP, then joins", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const { session } = yield* start(ircd.port);

      const lines = yield* eventually(ircd.received, (all) => all.length === 3);

      assert.deepStrictEqual(lines, ["NICK claude", "USER claude 0 * Claude", "JOIN #iirc"]);
      assert.strictEqual((yield* session.status).phase, "registered");
    }).pipe(Effect.scoped)
  );

  it.live("answers PING, even before registration", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd((line) =>
        line.startsWith("USER ") ? ["PING :cookie"] : []
      );

      yield* start(ircd.port);

      yield* eventually(ircd.received, (all) => all.includes("PONG cookie"));
    }).pipe(Effect.scoped)
  );

  it.live("records both directions, in order", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const { observed, session } = yield* start(ircd.port);
      yield* eventually(session.status, ({ phase }) => phase === "registered");

      const built = privmsg("#iirc", "hello");
      assert(built._tag === "Safe");
      yield* session.send(built.line);
      yield* ircd.push(":master!~u@host PRIVMSG #iirc :hi");

      const all = yield* eventually(Ref.get(observed), (seen) => seen.length === 7);
      assert.deepStrictEqual(
        all.map(({ direction, parsed }) => `${direction} ${parsed.text}`),
        [
          "outbound NICK claude",
          "outbound USER claude 0 * Claude",
          "inbound :ircd 001 claude :Welcome",
          "outbound JOIN #iirc",
          "inbound :claude!~u@host JOIN #iirc",
          "outbound PRIVMSG #iirc hello",
          "inbound :master!~u@host PRIVMSG #iirc :hi",
        ]
      );
    }).pipe(Effect.scoped)
  );

  it.live("survives garbage from the Ircd", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const { observed, session } = yield* start(ircd.port);
      yield* eventually(session.status, ({ phase }) => phase === "registered");

      yield* ircd.push("");
      yield* ircd.push(":only-a-source");
      yield* ircd.push("@only=tags");
      yield* ircd.push("PING :still-here");

      yield* eventually(ircd.received, (all) => all.includes("PONG still-here"));

      const unparseable = (yield* Ref.get(observed)).filter(
        ({ parsed }) => parsed._tag === "Unparseable"
      );

      assert.strictEqual(unparseable.length, 3);
      assert.strictEqual((yield* session.status).phase, "registered");
    }).pipe(Effect.scoped)
  );

  it.live("ends visibly when the nick is taken", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd((line) =>
        line.startsWith("NICK ") ? [":ircd 433 * claude :Nickname is already in use"] : []
      );

      const { session } = yield* start(ircd.port);

      const status = yield* eventually(session.status, ({ phase }) => phase === "closed");

      assert.strictEqual(status.closeReason, "Nick claude is already in use");
    }).pipe(Effect.scoped)
  );

  it.live("ends visibly when the Connection drops", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const { session } = yield* start(ircd.port);
      yield* eventually(session.status, ({ phase }) => phase === "registered");

      yield* ircd.hangUp;

      const status = yield* eventually(session.status, ({ phase }) => phase === "closed");
      assert.isDefined(status.closeReason);
    }).pipe(Effect.scoped)
  );

  it.live("ends visibly when nothing is listening", () =>
    Effect.gen(function* () {
      const ircd = yield* Effect.scoped(scriptedIrcd(welcoming("claude")));
      const { session } = yield* start(ircd.port);

      const status = yield* eventually(session.status, ({ phase }) => phase === "closed");

      assert.isDefined(status.closeReason);
    }).pipe(Effect.scoped)
  );

  it.live("refuses to send without a Session", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(() => []);
      const { session } = yield* start(ircd.port);
      const built = privmsg("#iirc", "too soon");
      assert(built._tag === "Safe");

      const error = yield* Effect.flip(session.send(built.line));

      assert.strictEqual(error._tag, "NotInSession");
    }).pipe(Effect.scoped)
  );
});
