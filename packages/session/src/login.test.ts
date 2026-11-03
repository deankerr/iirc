import { assert, describe, it } from "@effect/vitest";
import { deadline, fold } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Clock, Effect, Fiber, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { ChannelKey } from "./connection.ts";
import type { Entry } from "./entry.ts";
import { toEvent } from "./events.ts";
import {
  deadlinesNamed,
  decode,
  droppedIn,
  entries,
  host,
  input,
  linesOf,
  liveHost,
  options,
  safe,
  manyTurns,
  texts,
  wire,
} from "./network.fixture.ts";
import type { Overrides } from "./network.fixture.ts";
import { constantNetwork, hostNetwork } from "./network.ts";
import { Recorder } from "./recorder.ts";
import { foldStandings, loginOf, noStanding, noStandings } from "./standing.ts";
import { fakeIrcd, movingClockWhileClosing } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";
import { Transport } from "./transport.ts";

const memory = Effect.provide(Recorder.memoryReadable);

const welcome = ":ircd 001 iirc :Welcome\r\n";
const noMotd = ":ircd 422 iirc :No MOTD\r\n";
const inOne = ":iirc!~u@host JOIN #one\r\n";

const secrets = new Map([
  ["pass", Redacted.make("hunter2")],
  ["nickserv", Redacted.make("s3cret")],
  ["oper", Redacted.make("operpw")],
  ["key.one", Redacted.make("pizza")],
]);

// `IDENTIFY`, then two connect commands, one of them holding a Credential.
const loggingIn: Overrides = {
  channels: [{ name: "#one" }],
  connectCommands: ["MODE iirc +x", "OPER iirc {{oper}}"],
  credentials: { service: { nick: "NickServ", password: "nickserv" } },
  secrets,
  services: ["NickServ"],
};

const outbound = (log: readonly Entry[]) =>
  linesOf(log).filter(({ direction }) => direction === "outbound");

const joins = (ircd: FakeIrcd) =>
  Effect.map(wire(ircd), (written) => written.filter((line) => line.startsWith("JOIN")));

// Brings a host through its burst, with the login sequence out and the rejoin wait over.
const pastBurst = Effect.fnUntraced(function* (ircd: FakeIrcd, overrides: Overrides = loggingIn) {
  const hosted = yield* host(ircd, overrides);

  yield* ircd.read(`${welcome}${noMotd}`);
  yield* manyTurns;
  yield* TestClock.adjust(`${defaultTuning.rejoinSettleMillis} millis`);
  yield* manyTurns;

  return hosted;
});

// What a fold of the whole Log says, from nothing, as a restart or `/state?at=` would.
const replayedLogin = (log: readonly Entry[]) =>
  loginOf(foldStandings(noStandings, log).get(options.id) ?? noStanding);

describe("CONN-2: `PASS`", () => {
  it.effect("CONN-2, LOG-6: goes first, on the control lane, and is recorded `<redacted>`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd, { credentials: { password: "pass" }, secrets });

      assert.deepStrictEqual(yield* wire(ircd), [
        "PASS hunter2\r\n",
        "NICK iirc\r\n",
        "USER user 0 * :I IRC\r\n",
      ]);

      const [pass] = outbound(yield* entries);

      assert.deepInclude(pass, { cause: "registration", redacted: ["pass"] });
      assert.strictEqual(decode(pass?.bytes ?? new Uint8Array()), "PASS <redacted>");
      assert.notInclude(JSON.stringify(texts(yield* entries, "outbound")), "hunter2");
    }).pipe(memory)
  );
});

describe("CONN-6: `IDENTIFY`, connect commands, and the login wait", () => {
  it.effect("CONN-6: sends `IDENTIFY`, then each connect command, after the burst", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* host(ircd, loggingIn);
      yield* ircd.read(welcome);
      yield* manyTurns;

      assert.lengthOf(yield* wire(ircd), 2);

      yield* ircd.read(noMotd);
      yield* manyTurns;

      assert.deepStrictEqual((yield* wire(ircd)).slice(2), [
        "PRIVMSG NickServ :IDENTIFY s3cret\r\n",
        "MODE iirc +x\r\n",
        "OPER iirc operpw\r\n",
      ]);

      const sent = outbound(yield* entries).slice(2);

      assert.deepStrictEqual(
        sent.map(({ bytes, cause, redacted }) => ({ cause, redacted, text: decode(bytes) })),
        [
          {
            cause: "identify",
            redacted: ["nickserv"],
            text: "PRIVMSG NickServ :IDENTIFY <redacted>",
          },
          { cause: "connect-command", redacted: undefined, text: "MODE iirc +x" },
          { cause: "connect-command", redacted: ["oper"], text: "OPER iirc <redacted>" },
        ]
      );
    }).pipe(memory)
  );

  it.effect("CONN-6: holds joins while it waits, and times out with a Deadline Entry", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* pastBurst(ircd);
      const lastWritten = outbound(yield* entries).at(-1)?.at ?? 0;

      assert.deepStrictEqual((yield* hosted.status).login, { state: "waiting" });
      assert.deepStrictEqual(yield* joins(ircd), []);

      const left = lastWritten + defaultTuning.loginWaitMillis - (yield* Clock.currentTimeMillis);

      yield* TestClock.adjust(`${left - 1} millis`);
      yield* manyTurns;

      assert.deepStrictEqual(yield* joins(ircd), []);
      assert.lengthOf(deadlinesNamed(yield* entries, "login"), 0);

      yield* TestClock.adjust("1 millis");
      yield* manyTurns;

      const [expired] = deadlinesNamed(yield* entries, "login");

      assert.strictEqual(expired?.at, lastWritten + defaultTuning.loginWaitMillis);
      assert.deepStrictEqual((yield* hosted.status).login, { state: "timedOut" });
      assert.deepStrictEqual(yield* joins(ircd), ["JOIN #one\r\n"]);
    }).pipe(memory)
  );

  it.effect(
    "CONN-6: measures the wait from the last Line written, which flood control can hold",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const tuning = { ...defaultTuning, floodBurst: 1 };

        yield* pastBurst(ircd, { ...loggingIn, tuning });

        // One token, and the rest a Line every two seconds.
        yield* TestClock.adjust("4 seconds");
        yield* manyTurns;

        const sent = outbound(yield* entries).filter(({ cause }) => cause !== "registration");
        const last = sent.at(-1)?.at ?? 0;

        assert.deepStrictEqual(
          sent.map(({ cause }) => cause),
          ["identify", "connect-command", "connect-command"]
        );
        assert.strictEqual(last - (sent[0]?.at ?? 0), 4000);

        yield* TestClock.adjust(`${defaultTuning.loginWaitMillis} millis`);
        yield* manyTurns;

        assert.strictEqual(
          deadlinesNamed(yield* entries, "login")[0]?.at,
          last + defaultTuning.loginWaitMillis
        );
      }).pipe(memory)
  );

  for (const [name, sign, text] of [
    [
      "`900`",
      ":ircd 900 iirc iirc!~u@host iirc :You are now logged in as iirc",
      "You are now logged in as iirc",
    ],
    ["`+r` on Self", ":iirc MODE iirc :+r", "iirc +r"],
    [
      "a service's `NOTICE`",
      ":NickServ!s@services. NOTICE iirc :You are now identified for \u0002iirc\u0002.",
      "You are now identified for \u0002iirc\u0002.",
    ],
  ] as const) {
    it.effect(`CONN-6: ends the wait early on ${name}, and joins`, () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const hosted = yield* pastBurst(ircd);

        yield* ircd.read(`${sign}\r\n`);
        yield* manyTurns;

        assert.deepStrictEqual((yield* hosted.status).login, { state: "succeeded", text });
        assert.deepStrictEqual(yield* joins(ircd), ["JOIN #one\r\n"]);

        yield* TestClock.adjust("1 minute");
        yield* manyTurns;

        assert.lengthOf(deadlinesNamed(yield* entries, "login"), 0);
      }).pipe(memory)
    );
  }

  it.effect("CONN-6: ends the wait on `904`, and status shows the words", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* pastBurst(ircd);

      yield* ircd.read(":ircd 904 iirc :SASL authentication failed\r\n");
      yield* manyTurns;

      assert.deepStrictEqual((yield* hosted.status).login, {
        state: "failed",
        text: "SASL authentication failed",
      });
      assert.deepStrictEqual(yield* joins(ircd), ["JOIN #one\r\n"]);
    }).pipe(memory)
  );

  it.effect("CONN-6: ends the wait on a service saying the password is wrong", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* pastBurst(ircd);

      yield* ircd.read(":NickServ!s@services. NOTICE iirc :Invalid password for iirc.\r\n");
      yield* manyTurns;

      assert.deepStrictEqual((yield* hosted.status).login, {
        state: "failed",
        text: "Invalid password for iirc.",
      });
    }).pipe(memory)
  );

  it.effect("CONN-6: with connect commands and no service password, joins once they are out", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* pastBurst(ircd, { ...loggingIn, credentials: {} });

      assert.deepStrictEqual((yield* hosted.status).login, { state: "none" });
      assert.deepStrictEqual((yield* wire(ircd)).slice(2), [
        "MODE iirc +x\r\n",
        "OPER iirc operpw\r\n",
        "JOIN #one\r\n",
      ]);
    }).pipe(memory)
  );

  it.effect("ADR 0003: a fold of the Log gives the same login outcome as status", () =>
    Effect.gen(function* () {
      for (const sign of [
        undefined,
        ":ircd 904 iirc :SASL authentication failed",
        ":NickServ!s@h NOTICE iirc :Password accepted - you are now recognized.",
      ]) {
        const ircd = yield* fakeIrcd();
        const hosted = yield* pastBurst(ircd, { ...loggingIn, id: `n${String(sign?.length)}` });

        yield* sign === undefined ? TestClock.adjust("1 minute") : ircd.read(`${sign}\r\n`);
        yield* manyTurns;

        const status = yield* hosted.status;

        const log = (yield* entries).filter(
          (entry) => !("network" in entry) || entry.network === `n${String(sign?.length)}`
        );

        assert.deepStrictEqual(
          loginOf(foldStandings(noStandings, log).get(`n${String(sign?.length)}`) ?? noStanding),
          status.login
        );
        assert.notStrictEqual(status.login.state, "waiting");

        // Nor does the machine, folded the same way, wait for anything.
        const machine = fold(
          log.flatMap((entry) => toEvent(entry) ?? []),
          input
        );

        assert.notStrictEqual(deadline(machine)?.name, "login");
      }
    }).pipe(memory)
  );

  it.effect("ADR 0003: a fold of a timed-out wait agrees, from the Deadline Entry alone", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* pastBurst(ircd);
      yield* TestClock.adjust("1 minute");
      yield* manyTurns;

      assert.deepStrictEqual(replayedLogin(yield* entries), { state: "timedOut" });
    }).pipe(memory)
  );
});

describe("LOG-6: value scrubbing on a live Connection", () => {
  it.effect("LOG-6: an Ircd echoing a password back is recorded `<redacted>`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* pastBurst(ircd, { ...loggingIn, connectCommands: [], credentials: {} });
      yield* ircd.read(":bob!u@h PRIVMSG #one :you said hunter2, and s3cret:\r\n");
      yield* manyTurns;

      const said = linesOf(yield* entries).at(-1);

      assert.strictEqual(
        decode(said?.bytes ?? new Uint8Array()),
        ":bob!u@h PRIVMSG #one :you said <redacted>, and <redacted>:"
      );
      assert.deepStrictEqual(said?.redacted, ["pass", "nickserv"]);
    }).pipe(memory)
  );

  it.effect("LOG-6: a value inside another word is left as it is", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const text = ":bob!u@h PRIVMSG #one :pizzas, xpizza, hunter22 and pizza!";

      yield* pastBurst(ircd, { ...loggingIn, connectCommands: [], credentials: {} });
      yield* ircd.read(`${text}\r\n`);
      yield* manyTurns;

      const said = linesOf(yield* entries).at(-1);

      assert.strictEqual(decode(said?.bytes ?? new Uint8Array()), text);
      assert.isUndefined(said?.redacted);
    }).pipe(memory)
  );

  it.effect("LOG-6: a Frontend's Line holding a password is scrubbed, written or Dropped", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const hosted = yield* pastBurst(ircd, { ...loggingIn, connectCommands: [], credentials: {} });

      yield* ircd.setWrites("hang");

      const first = yield* Effect.forkChild(
        hosted.send(safe("PRIVMSG", ["#one", "it is hunter2"]), "key:phone")
      );

      const second = yield* Effect.forkChild(
        hosted.send(safe("PRIVMSG", ["#one", "really hunter2"]), "key:phone")
      );

      yield* manyTurns;
      yield* ircd.hangUp;
      yield* manyTurns;
      yield* Fiber.join(first).pipe(Effect.ignore);
      yield* Fiber.join(second).pipe(Effect.ignore);

      const log = yield* entries;
      const dropped = droppedIn(log).filter(({ cause }) => cause === "key:phone");

      assert.lengthOf(dropped, 2);
      assert.deepStrictEqual(
        dropped.map(({ bytes, redacted }) => ({ redacted, text: decode(bytes) })),
        [
          { redacted: ["pass"], text: "PRIVMSG #one :it is <redacted>" },
          { redacted: ["pass"], text: "PRIVMSG #one :really <redacted>" },
        ]
      );
      assert.notInclude(log.map((entry) => JSON.stringify(entry)).join(","), "hunter2");
    }).pipe(memory)
  );
});

describe("CRED-1: a Credential that is not set", () => {
  it.effect("CRED-1: makes no `attempt`, and status lists every missing name", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      const { change, hosted } = yield* liveHost(ircd, {
        connectCommands: ["OPER iirc {{oper}}"],
        credentials: {
          clientCertificate: "cert",
          password: "pass",
          service: { nick: "NickServ", password: "nickserv" },
        },
        secrets: new Map(),
      });

      const status = yield* hosted.status;

      assert.deepStrictEqual(status.missingCredentials, ["pass", "nickserv", "cert", "oper"]);
      assert.isUndefined(status.nextAttemptAt);
      assert.strictEqual(status.phase, "idle");
      assert.deepStrictEqual(yield* ircd.dials, []);
      assert.lengthOf(yield* entries, 0);

      yield* change((settings) => ({
        ...settings,
        secrets: new Map([...secrets, ["cert", Redacted.make("PEM")]]),
      }));

      assert.deepStrictEqual((yield* hosted.status).missingCredentials, []);
      assert.lengthOf(yield* ircd.dials, 1);
    }).pipe(memory)
  );

  it.effect(
    "CRED-4: a Channel whose key is not set is joined without one, and blocks nothing",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();

        const hosted = yield* pastBurst(ircd, {
          channels: [{ key: "key.gone", name: "#one" }],
          secrets: new Map(),
        });

        assert.deepStrictEqual((yield* hosted.status).missingCredentials, []);
        assert.deepStrictEqual(yield* joins(ircd), ["JOIN #one\r\n"]);
      }).pipe(memory)
  );
});

describe("CRED-4: Channel keys an inbound `MODE` sets", () => {
  const watching = Effect.fnUntraced(function* (ircd: FakeIrcd, overrides?: Overrides) {
    const seen = yield* Ref.make<readonly ChannelKey[]>([]);
    const { id, ...settings } = { ...options, channels: [], secrets, ...overrides };

    yield* movingClockWhileClosing(
      hostNetwork({
        ...constantNetwork(id, settings),
        onChannelKey: (change) => Ref.update(seen, (held) => [...held, change]),
      }).pipe(Effect.provideService(Transport, ircd.transport))
    );

    yield* ircd.read(`${welcome}${noMotd}${inOne}`);
    yield* manyTurns;

    const keys = Effect.map(Ref.get(seen), (held) =>
      held.map(({ channel, key }) => ({
        channel,
        key: key === undefined ? undefined : Redacted.value(key),
      }))
    );

    return { keys };
  });

  it.effect("CRED-4: tells of a `+k`, and of a `-k`, once each is recorded", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { keys } = yield* watching(ircd);

      yield* ircd.read(":op!u@h MODE #one +k sesame\r\n:op!u@h MODE #one -k sesame\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(yield* keys, [
        { channel: "#one", key: "sesame" },
        { channel: "#one", key: undefined },
      ]);
    }).pipe(memory)
  );

  it.effect("CRED-4: a key shown as `*` says nothing, and a bare `-k` takes it away", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { keys } = yield* watching(ircd);

      yield* ircd.read(":op!u@h MODE #one +k *\r\n:op!u@h MODE #one -k\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(yield* keys, [{ channel: "#one", key: undefined }]);
    }).pipe(memory)
  );

  it.effect("CRED-4, KNOW-6: reads `+ok nick key` by the Session's `PREFIX`", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { keys } = yield* watching(ircd);

      yield* ircd.read(":op!u@h MODE #one +ok bob sesame\r\n");
      yield* ircd.read(":ircd 005 iirc PREFIX=(qaohv)~&@%+ :are supported\r\n");
      yield* ircd.read(":op!u@h MODE #one +qk bob other\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(yield* keys, [
        { channel: "#one", key: "sesame" },
        { channel: "#one", key: "other" },
      ]);
    }).pipe(memory)
  );

  it.effect("CRED-4: says nothing of a Channel Self is not in, or of a `MODE` that is uneven", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { keys } = yield* watching(ircd);

      yield* ircd.read(":op!u@h MODE #two +k sesame\r\n:op!u@h MODE #one +ok bob\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(yield* keys, []);
    }).pipe(memory)
  );

  it.effect(
    "CRED-4: reads a `MODE` as it stood at its Entry, though Self parts in the same read",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const { keys } = yield* watching(ircd);

        yield* ircd.read(":op!u@h MODE #one +k sesame\r\n:iirc!~u@host PART #one\r\n");
        yield* manyTurns;

        assert.deepStrictEqual(yield* keys, [{ channel: "#one", key: "sesame" }]);
      }).pipe(memory)
  );

  it.effect("CRED-4, LOG-6: a key already held is scrubbed, and still told by its value", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { keys } = yield* watching(ircd);

      yield* ircd.read(":op!u@h MODE #one +k pizza\r\n");
      yield* manyTurns;

      const mode = linesOf(yield* entries).at(-1);

      assert.strictEqual(
        decode(mode?.bytes ?? new Uint8Array()),
        ":op!u@h MODE #one +k <redacted>"
      );
      assert.deepStrictEqual(mode?.redacted, ["key.one"]);
      assert.deepStrictEqual(yield* keys, [{ channel: "#one", key: "pizza" }]);
    }).pipe(memory)
  );

  it.effect(
    "CRED-4, LOG-6: two Credentials scrubbed from one `MODE` leave the key whichever place it stands",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const { keys } = yield* watching(ircd);

        yield* ircd.read(":op!u@h MODE #one +ok pizza hunter2\r\n");
        yield* manyTurns;

        const first = linesOf(yield* entries).at(-1);

        assert.strictEqual(
          decode(first?.bytes ?? new Uint8Array()),
          ":op!u@h MODE #one +ok <redacted> <redacted>"
        );
        assert.deepStrictEqual(first?.redacted, ["key.one", "pass"]);

        yield* ircd.read(":op!u@h MODE #one +ko hunter2 pizza\r\n");
        yield* ircd.read(":op!u@h MODE #one +ok hunter2 pizza\r\n");
        yield* manyTurns;

        assert.deepStrictEqual(yield* keys, [
          { channel: "#one", key: "hunter2" },
          { channel: "#one", key: "hunter2" },
          { channel: "#one", key: "pizza" },
        ]);
      }).pipe(memory)
  );

  it.effect(
    "CRED-4, LOG-6: a key that is no Credential is told as it came, beside one that was scrubbed",
    () =>
      Effect.gen(function* () {
        const ircd = yield* fakeIrcd();
        const { keys } = yield* watching(ircd);

        yield* ircd.read(":op!u@h MODE #one +ok hunter2 sesame\r\n");
        yield* ircd.read(":op!u@h MODE #one +ko sesame hunter2\r\n");
        yield* manyTurns;

        const mode = linesOf(yield* entries).at(-1);

        assert.strictEqual(
          decode(mode?.bytes ?? new Uint8Array()),
          ":op!u@h MODE #one +ko sesame <redacted>"
        );
        assert.deepStrictEqual(mode?.redacted, ["pass"]);
        assert.deepStrictEqual(yield* keys, [
          { channel: "#one", key: "sesame" },
          { channel: "#one", key: "sesame" },
        ]);
      }).pipe(memory)
  );

  it.effect("CRED-4: a `<redacted>` the Ircd sent itself leaves the key unknown", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { keys } = yield* watching(ircd);

      yield* ircd.read(":op!u@h MODE #one +ok <redacted> pizza\r\n");
      yield* manyTurns;

      assert.deepStrictEqual(yield* keys, []);
    }).pipe(memory)
  );
});
