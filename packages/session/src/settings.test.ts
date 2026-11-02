import { assert, describe, it } from "@effect/vitest";
import { deadline, fold, phase } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";

import type { Entry, Ircd, Json } from "./entry.ts";
import { toEvent } from "./events.ts";
import {
  address,
  bareHost,
  connectionsOf,
  entries,
  liveHost,
  options,
  settled,
  wire,
} from "./network.fixture.ts";
import type { NetworkHost } from "./network.ts";
import { Recorder } from "./recorder.ts";
import { nextAttempt } from "./standing.ts";
import { fakeIrcd } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";

const memory = Effect.provide(Recorder.memoryReadable);

const welcome = ":ircd 001 iirc :Welcome\r\n";
const noMotd = ":ircd 422 iirc :No MOTD\r\n";
const joined = (name: string) => `:iirc!~u@host JOIN ${name}\r\n`;
const other: Ircd = { host: "other.test", port: 6697, tls: true };

const now = Clock.currentTimeMillis;

// Records a Change as the Daemon would, and gives its sequence.
const recordChange = (change: Json) =>
  Recorder.use(({ record }) =>
    record(
      [{ _tag: "Change", by: "local", change, network: options.id }],
      ([{ sequence }]) => sequence
    )
  );

const burstOver = (ircd: FakeIrcd) =>
  Effect.gen(function* () {
    yield* ircd.read(`${welcome}${noMotd}`);
    yield* settled;
    yield* TestClock.adjust(`${defaultTuning.rejoinSettleMillis} millis`);
    yield* settled;
  });

const joinsOn = (ircd: FakeIrcd, connection: number) =>
  Effect.map(ircd.writtenOn(connection), (written) =>
    written
      .map((bytes) => new TextDecoder().decode(bytes))
      .filter((text) => text.startsWith("JOIN"))
  );

const untilDue = Effect.fnUntraced(function* (hosted: NetworkHost) {
  const { nextAttemptAt } = yield* hosted.status;

  yield* TestClock.adjust(`${(nextAttemptAt ?? 0) - (yield* now)} millis`);
  yield* settled;
});

describe("CONF-2, LIVE-9: enabled", () => {
  it.effect("LIVE-9: disabling leaves a Session by choice, and enabling comes straight back", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd, { channels: [] });

      yield* burstOver(ircd);
      yield* change((settings) => ({ ...settings, enabled: false, quitReason: "a break" }));

      const log = yield* entries;
      const closing = connectionsOf(log, "closing");

      assert.deepStrictEqual(
        closing.map(({ chosen, reason }) => ({ chosen, reason })),
        [{ chosen: true, reason: "a break" }]
      );
      assert.strictEqual((yield* wire(ircd)).at(-1), "QUIT :a break\r\n");
      assert.lengthOf(connectionsOf(log, "closed"), 1);

      const disabled = yield* hosted.status;

      assert.isFalse(disabled.enabled);
      assert.strictEqual(disabled.phase, "closed");
      assert.isUndefined(disabled.nextAttemptAt);

      yield* TestClock.adjust("1 hour");
      yield* settled;

      assert.lengthOf(yield* ircd.dials, 1);

      // A chosen leave is no failure, so being enabled again needs no wait.
      yield* change((settings) => ({ ...settings, enabled: true }));

      assert.lengthOf(yield* ircd.dials, 2);
      assert.isTrue((yield* hosted.status).enabled);
      assert.strictEqual((yield* hosted.status).phase, "registering");
    }).pipe(memory)
  );

  it.effect("CONF-2: a host disabled from the start makes no attempt until enabled", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd, { enabled: false });

      yield* TestClock.adjust("1 hour");
      yield* settled;

      assert.lengthOf(yield* ircd.dials, 0);
      assert.lengthOf(yield* entries, 0);
      assert.deepInclude(yield* hosted.status, {
        enabled: false,
        nextAttemptAt: undefined,
        phase: "idle",
      });

      yield* change((settings) => ({ ...settings, enabled: true }));

      assert.lengthOf(yield* ircd.dials, 1);
    }).pipe(memory)
  );

  it.effect("CONF-2: disabled during a backoff, no attempt is made when it is due", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const { change, hosted } = yield* liveHost(ircd);
      const due = (yield* hosted.status).nextAttemptAt ?? 0;

      yield* change((settings) => ({ ...settings, enabled: false }));
      yield* TestClock.adjust(`${due - (yield* now) + 60_000} millis`);
      yield* settled;

      assert.lengthOf(yield* ircd.dials, 1);

      // The backoff ran out while disabled, so nothing is left of it.
      yield* change((settings) => ({ ...settings, enabled: true }));

      assert.lengthOf(yield* ircd.dials, 2);
    }).pipe(memory)
  );

  it.effect("LIVE-9: the `QUIT` reason is read as the host leaves, and not before", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change } = yield* liveHost(ircd, { channels: [] });

      yield* burstOver(ircd);

      const written = (yield* wire(ircd)).length;

      yield* change((settings) => ({ ...settings, quitReason: "first try" }));
      yield* change((settings) => ({ ...settings, quitReason: "second wind" }));

      assert.lengthOf(yield* wire(ircd), written);
      assert.lengthOf(connectionsOf(yield* entries, "closing"), 0);

      yield* change((settings) => ({ ...settings, enabled: false }));

      assert.strictEqual((yield* wire(ircd)).at(-1), "QUIT :second wind\r\n");
    }).pipe(memory)
  );

  it.effect("LIVE-9: a stop says the `QUIT` reason the settings hold by then", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { change } = yield* liveHost(ircd, { channels: [] });

          yield* burstOver(ircd);
          yield* change((settings) => ({ ...settings, quitReason: "changed my mind" }));
        })
      );

      assert.strictEqual((yield* wire(ircd)).at(-1), "QUIT :changed my mind\r\n");
      assert.strictEqual(connectionsOf(yield* entries, "closing")[0]?.reason, "changed my mind");
    }).pipe(memory)
  );
});

describe("LIVE-4: a retry the Owner asked for", () => {
  it.effect("LIVE-4: a Change asking for a retry dials at once, whatever the backoff", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const { change, hosted } = yield* liveHost(ircd);

      yield* untilDue(hosted);
      yield* untilDue(hosted);

      assert.lengthOf(yield* ircd.dials, 3);
      assert.isAbove((yield* hosted.status).nextAttemptAt ?? 0, yield* now);

      const retrySince = yield* recordChange({ retry: true });

      yield* change((settings) => ({ ...settings, retrySince }));

      assert.lengthOf(yield* ircd.dials, 4);

      // The retry is answered, and backoff carries on from where it was.
      const { consecutiveFailures, nextAttemptAt } = yield* hosted.status;

      assert.strictEqual(consecutiveFailures, 4);
      assert.isAtLeast((nextAttemptAt ?? 0) - (yield* now), 20_000);
    }).pipe(memory)
  );

  it.effect("LIVE-4, LIVE-5: and during a refusal's wait", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd);

      yield* ircd.read("ERROR :You are banned\r\n");
      yield* ircd.hangUp;
      yield* settled;

      assert.isTrue((yield* hosted.status).refused);
      assert.strictEqual(
        ((yield* hosted.status).nextAttemptAt ?? 0) - (yield* now),
        defaultTuning.refusalBackoffMillis
      );

      const retrySince = yield* recordChange({ ircds: "changed" });

      yield* change((settings) => ({ ...settings, retrySince }));

      assert.lengthOf(yield* ircd.dials, 2);
    }).pipe(memory)
  );

  it.effect("LIVE-4: a new host on the same Log and settings decides as the last one did", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd({ refuses: true });
      const retrySince = yield* recordChange({ retry: true });
      const settings = { ...options, retrySince };

      yield* Effect.scoped(bareHost(ircd, settings));

      assert.lengthOf(yield* ircd.dials, 1);

      // The `attempt` answered the retry, so a restart backs off as it would have.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosted = yield* bareHost(ircd, settings);
          const standing = yield* Recorder.use(({ standing: read }) => read(options.id));

          assert.lengthOf(yield* ircd.dials, 1);
          assert.strictEqual(
            (yield* hosted.status).nextAttemptAt,
            nextAttempt(standing, settings).at
          );
        })
      );
    }).pipe(memory)
  );
});

describe("CONF-2: what applies at the next Connection", () => {
  it.effect("CONF-2: Ircds, Identity, and Tuning are read at each attempt", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd, { channels: [] });

      yield* burstOver(ircd);

      const written = (yield* wire(ircd)).length;

      yield* change((settings) => ({
        ...settings,
        identity: { alternates: ["spare"], nick: "renamed", realname: "Real Name", username: "u" },
        ircds: [other, address],
        tuning: { ...defaultTuning, reconnectInitialMillis: 1000 },
      }));

      // Nothing about the Session it is in changes.
      assert.lengthOf(yield* wire(ircd), written);
      assert.strictEqual((yield* hosted.status).phase, "session");

      yield* ircd.hangUp;
      yield* settled;

      const delay = ((yield* hosted.status).nextAttemptAt ?? 0) - (yield* now);

      assert.isAtLeast(delay, 500);
      assert.isAtMost(delay, 1000);

      yield* untilDue(hosted);

      // The last `attempt` used `address`, so the rotation goes on from there.
      assert.deepStrictEqual((yield* ircd.dials).at(-1), other);
      assert.deepStrictEqual(
        connectionsOf(yield* entries, "attempt")
          .at(-1)
          ?.nicks.slice(0, 2),
        ["renamed", "spare"]
      );
      assert.deepStrictEqual(
        (yield* ircd.writtenOn(1)).map((bytes) => new TextDecoder().decode(bytes)),
        ["NICK renamed\r\n", "USER u 0 * :Real Name\r\n"]
      );
    }).pipe(memory)
  );
});

describe("LIVE-7, LIVE-8: the Channels wanted", () => {
  it.effect("LIVE-8, CONF-2: a Channel wanted during a Session is joined in it", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change } = yield* liveHost(ircd, { channels: [{ name: "#one" }] });

      yield* burstOver(ircd);
      yield* ircd.read(joined("#one"));
      yield* settled;

      assert.deepStrictEqual(yield* joinsOn(ircd, 0), ["JOIN #one\r\n"]);

      yield* change((settings) => ({
        ...settings,
        channels: [...settings.channels, { name: "#two" }],
      }));

      assert.deepStrictEqual(yield* joinsOn(ircd, 0), ["JOIN #one\r\n", "JOIN #two\r\n"]);
    }).pipe(memory)
  );

  it.effect("LIVE-7: a Channel no Line can carry, wanted during a Session, is never tried", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd, { channels: [] });

      yield* burstOver(ircd);

      assert.lengthOf((yield* hosted.status).rejectedChannels, 0);

      yield* change((settings) => ({ ...settings, channels: [{ name: "#a b" }] }));

      assert.deepStrictEqual(
        (yield* hosted.status).rejectedChannels.map(({ channel, reason }) => [
          channel.name,
          reason,
        ]),
        [["#a b", "InvalidChannel"]]
      );
      assert.deepStrictEqual(yield* joinsOn(ircd, 0), []);
    }).pipe(memory)
  );

  it.effect("LIVE-8, CONF-5: the Owner joining again clears a kick, with no Session", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd, { channels: [{ name: "#one" }] });

      yield* burstOver(ircd);
      yield* ircd.read(joined("#one"));
      yield* ircd.read(":op!u@h KICK #one iirc :out\r\n");
      yield* ircd.hangUp;
      yield* settled;

      assert.lengthOf((yield* hosted.status).kicked, 1);

      const since = yield* recordChange({ join: "#one" });

      yield* change((settings) => ({ ...settings, channels: [{ name: "#one", since }] }));

      assert.lengthOf((yield* hosted.status).kicked, 0);

      yield* untilDue(hosted);
      yield* burstOver(ircd);

      assert.deepStrictEqual(yield* joinsOn(ircd, 1), ["JOIN #one\r\n"]);
    }).pipe(memory)
  );

  it.effect("LIVE-8: without the Owner joining again, the kick still wins", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const { change, hosted } = yield* liveHost(ircd, { channels: [{ name: "#one" }] });

      yield* burstOver(ircd);
      yield* ircd.read(joined("#one"));
      yield* ircd.read(":op!u@h KICK #one iirc :out\r\n");
      yield* settled;

      // A Change that came before the kick does not outrank it.
      yield* change((settings) => ({ ...settings, channels: [{ name: "#one", since: 1 }] }));
      yield* TestClock.adjust("1 hour");
      yield* settled;

      assert.lengthOf((yield* hosted.status).kicked, 1);
      assert.deepStrictEqual(yield* joinsOn(ircd, 0), ["JOIN #one\r\n"]);
    }).pipe(memory)
  );
});

// Replays Entries as `/state?at=` would, starting the machine from today's settings.
const replay = (log: readonly Entry[], tuning = defaultTuning) =>
  fold(
    log.flatMap((entry) => toEvent(entry) ?? []),
    { loginLines: 0, realname: "Today", services: [], tuning, username: "today" }
  );

describe("ADR 0003: a replay makes the decisions the Connection made", () => {
  it.effect("LIVE-2, CONN-2: a Connection replayed after a Tuning change keeps its deadlines", () =>
    Effect.gen(function* () {
      const ircd = yield* fakeIrcd();
      const short = { ...defaultTuning, registrationTimeoutMillis: 5000 };
      const { change } = yield* liveHost(ircd, { tuning: short });

      const [opened] = connectionsOf(yield* entries, "opened");

      yield* TestClock.adjust("5 seconds");
      yield* settled;

      // Every later Connection runs on the new numbers, and this one never did.
      const long = { ...defaultTuning, registrationTimeoutMillis: 600_000 };

      yield* change((settings) => ({ ...settings, tuning: long }));

      const log = yield* entries;
      const expired = log.findIndex((entry) => entry._tag === "Deadline");
      const untilOpened = opened === undefined ? 0 : log.indexOf(opened) + 1;

      assert.deepStrictEqual(connectionsOf(log, "attempt")[0]?.tuning, short);
      assert.isAbove(expired, 0);
      assert.deepStrictEqual(deadline(replay(log.slice(0, untilOpened), long)), {
        at: (opened?.at ?? 0) + 5000,
        name: "registration",
      });

      // Replayed on today's numbers, the Deadline Entry would be early and do nothing.
      assert.strictEqual(phase(replay(log.slice(0, expired + 1), long)), "closing");
      assert.strictEqual(phase(replay(log, long)), phase(replay(log, defaultTuning)));
    }).pipe(memory)
  );
});
