import { BunSocket } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { DaemonApi } from "@iirc/api";
import type { ScriptedIrcd } from "@iirc/session/testing";
import { eventually, scriptedIrcd, welcoming } from "@iirc/session/testing";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";

import { Daemon } from "./daemon.ts";
import { handlers } from "./http.ts";

const daemonOn = (ircd: ScriptedIrcd) =>
  Layer.unwrap(
    BunSocket.makeNet({ host: "127.0.0.1", port: ircd.port }).pipe(
      Effect.map((socket) =>
        Daemon.layer({
          channels: ["#iirc"],
          nick: "claude",
          realname: "Claude",
          socket,
          username: "claude",
        })
      )
    )
  );

const makeClient = HttpApiTest.groups(DaemonApi, ["daemon"]);

// The Daemon must outlive building the client, so its layer lives in the test's scope.
const withClient = (ircd: ScriptedIrcd) =>
  Layer.mergeAll(handlers.pipe(Layer.provide(daemonOn(ircd))), HttpServer.layerServices).pipe(
    Layer.build,
    Effect.flatMap((context) => makeClient.pipe(Effect.provide(context)))
  );

describe("Daemon API", () => {
  it.live("carries a hello and its reply through the Log", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const client = yield* withClient(ircd);
      yield* eventually(client.daemon.status(), ({ channels }) => channels.includes("#iirc"));

      yield* client.daemon.send({ payload: { target: "#iirc", text: "hello, master" } });
      yield* ircd.push(":master!~u@host PRIVMSG #iirc :hello, claude");

      const messages = yield* eventually(client.daemon.messages({ query: {} }), (all) =>
        all.some(({ sender }) => sender === "master")
      );

      assert.deepStrictEqual(
        messages.map(({ sender, target, text }) => ({ sender, target, text })),
        [
          { sender: "claude", target: "#iirc", text: "hello, master" },
          { sender: "master", target: "#iirc", text: "hello, claude" },
        ]
      );

      const replies = yield* client.daemon.messages({
        query: { after: messages[0]?.sequence ?? 0 },
      });

      assert.deepStrictEqual(
        replies.map(({ text }) => text),
        ["hello, claude"]
      );
    }).pipe(Effect.scoped)
  );

  it.live("exposes every Line, including those it can't parse", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const client = yield* withClient(ircd);
      yield* eventually(client.daemon.status(), ({ phase }) => phase === "registered");

      yield* ircd.push(":only-a-source");

      const lines = yield* eventually(client.daemon.lines({ query: {} }), (all) =>
        all.some(({ unparseable }) => unparseable !== null)
      );

      assert.strictEqual(lines[0]?.text, "NICK claude");
      assert.strictEqual(lines.at(-1)?.unparseable, "NoCommand");

      const tail = yield* client.daemon.lines({ query: { after: lines.length - 1 } });
      assert.strictEqual(tail.length, 1);
    }).pipe(Effect.scoped)
  );

  it.live("refuses a Message that would inject a second command", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const client = yield* withClient(ircd);
      yield* eventually(client.daemon.status(), ({ phase }) => phase === "registered");

      const error = yield* Effect.flip(
        client.daemon.send({ payload: { target: "#iirc", text: "hi\r\nQUIT :pwned" } })
      );

      assert.strictEqual(error._tag, "InvalidMessage");
      assert.notInclude(yield* ircd.received, "QUIT :pwned");
    }).pipe(Effect.scoped)
  );

  it.live("reports a typed failure once the Session has ended", () =>
    Effect.gen(function* () {
      const ircd = yield* scriptedIrcd(welcoming("claude"));
      const client = yield* withClient(ircd);
      yield* eventually(client.daemon.status(), ({ phase }) => phase === "registered");

      yield* ircd.hangUp;
      yield* eventually(client.daemon.status(), ({ phase }) => phase === "closed");

      const error = yield* Effect.flip(
        client.daemon.send({ payload: { target: "#iirc", text: "anyone?" } })
      );

      assert.strictEqual(error._tag, "NotInSession");
    }).pipe(Effect.scoped)
  );
});
