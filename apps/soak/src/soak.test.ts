import { readFileSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { eventually } from "@iirc/session/testing";
import { Effect, FileSystem, Schema } from "effect";

import { freePort } from "./ngircd.fixture.ts";
import { soakText } from "./soak-text.ts";
import {
  channel,
  checkOnce,
  currentMinute,
  heardCount,
  isCounted,
  network,
  sendInMinute,
  sendOnce,
  soak,
  twoDaemons,
} from "./world.fixture.ts";

// PROOF-5 end to end: two real Daemons on a private ngircd, and `iirc-soak send` and
// `check` run as the processes a timer runs. Nothing sleeps for a minute. The timer is
// outside, and a Message is numbered by the minute it is sent in, so a test sends in the
// minutes it wants (`sendInMinute`) and runs `send` itself once, on the real clock.

const withReport = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iirc-soak-report-" });

  return `${directory}/soak/report.jsonl`;
}).pipe(Effect.provide(BunServices.layer));

// The part of a line of the report these tests read.
const ReportLine = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    pairs: Schema.Array(
      Schema.Struct({
        delivered: Schema.Int,
        duplicates: Schema.String,
        pair: Schema.String,
        sent: Schema.Int,
        silences: Schema.String,
        unexplained: Schema.String,
      })
    ),
  })
);

const decodeReportLine = Schema.decodeSync(ReportLine);

const reportLines = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decodeReportLine(line));

describe.concurrent("PROOF-5: the soak harness against two Daemons", () => {
  it.live(
    "PROOF-5: send numbers a Message by the Unix minute it runs in, and check passes with every Message received once",
    () =>
      Effect.gen(function* () {
        const world = yield* twoDaemons;
        const report = yield* withReport;
        const minute = currentMinute();

        // Four minutes on the fake clock, and one run of the real program on the real one.
        for (const earlier of [4, 3, 2, 1]) {
          yield* sendInMinute(world.sender, minute - earlier);
        }

        const before = currentMinute();
        const sent = yield* sendOnce(world.sender);
        const after = currentMinute();

        const said = /sent "(?<text>soak (?<n>\d+) (?<millis>\d+))" \(written, Entry /u.exec(
          sent.stdout
        )?.groups;

        assert.strictEqual(sent.code, 0, sent.stderr);
        assert.isAtLeast(Number(said?.n), before);
        assert.isAtMost(Number(said?.n), after);
        // The minute is the millisecond's own, and the millisecond is of this run.
        assert.strictEqual(Math.floor(Number(said?.millis) / 60_000), Number(said?.n));

        yield* heardCount(world.receiver, 5);

        const heard = yield* world.receiver.client.daemon.messages({
          query: { after: 0, limit: 1000, network },
        });

        assert.deepStrictEqual(
          heard.filter(isCounted).map(({ text }) => text),
          [...[4, 3, 2, 1].map((earlier) => soakText((minute - earlier) * 60_000)), said?.text]
        );

        const checked = yield* checkOnce(world.receiver, world.sender, ["--report", report]);

        assert.strictEqual(checked.code, 0, checked.stderr + checked.stdout);
        assert.match(
          checked.stdout.trim(),
          new RegExp(
            `^soak ${network}:${network}=${channel} OK: sent 5; delivered 5; last sent \\d+ s ago$`,
            "u"
          )
        );

        // Checking again changes nothing: it keeps no state, and reads both Logs again.
        const again = yield* checkOnce(world.receiver, world.sender, ["--report", report]);

        assert.strictEqual(again.code, 0, again.stderr + again.stdout);

        const lines = reportLines(report);

        assert.lengthOf(lines, 2);
        assert.deepStrictEqual(lines[0], {
          ok: true,
          pairs: [
            {
              delivered: 5,
              duplicates: "",
              pair: `${network}:${network}=${channel}`,
              sent: 5,
              silences: "",
              unexplained: "",
            },
          ],
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );

  it.live(
    "PROOF-5: check fails, naming the number, when a Message is missing and no Gap or Dropped Entry explains it",
    () =>
      Effect.gen(function* () {
        const world = yield* twoDaemons;
        const report = yield* withReport;
        const minute = currentMinute();

        yield* sendInMinute(world.sender, minute - 2);
        yield* heardCount(world.receiver, 1);

        // The receiver leaves the Channel, so the next Message goes where it is not. No
        // Daemon was off the Network, so there is no Gap, and nothing was Dropped.
        yield* world.receiver.client.networks.part({
          params: { id: network },
          payload: { channel },
        });
        yield* eventually(
          world.receiver.status,
          (found) => found?.joined.includes(channel) === false
        );

        yield* sendInMinute(world.sender, minute - 1);

        yield* world.receiver.client.networks.join({
          params: { id: network },
          payload: { channel, remember: true },
        });
        yield* world.receiver.joined;

        yield* sendInMinute(world.sender, minute);
        yield* heardCount(world.receiver, 2);

        const checked = yield* checkOnce(world.receiver, world.sender, ["--report", report]);

        assert.strictEqual(checked.code, 1, checked.stdout);
        assert.include(checked.stdout, `FAILED: UNEXPLAINED in minutes 1 (${minute - 1});`);
        assert.include(checked.stdout, "sent 3; delivered 2");
        assert.include(checked.stderr, `FAILED: ${network}:${network}=${channel}`);

        const [line, ...others] = reportLines(report);

        assert.lengthOf(others, 0);
        assert.deepStrictEqual(line, {
          ok: false,
          pairs: [
            {
              delivered: 2,
              duplicates: "",
              pair: `${network}:${network}=${channel}`,
              sent: 3,
              silences: "",
              unexplained: `${minute - 1}`,
            },
          ],
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );

  it.live(
    "PROOF-5: check passes, saying why, when the missing Message was sent inside the receiver's Gap",
    () =>
      Effect.gen(function* () {
        const world = yield* twoDaemons;
        const minute = currentMinute();

        yield* sendInMinute(world.sender, minute - 2);
        yield* heardCount(world.receiver, 1);

        yield* world.receiver.client.networks.disconnect({ params: { id: network } });
        yield* world.receiver.left;

        yield* sendInMinute(world.sender, minute - 1);

        yield* world.receiver.client.networks.connect({ params: { id: network } });
        yield* world.receiver.joined;

        yield* sendInMinute(world.sender, minute);
        yield* heardCount(world.receiver, 2);

        const checked = yield* checkOnce(world.receiver, world.sender);

        assert.strictEqual(checked.code, 0, checked.stderr + checked.stdout);
        assert.match(
          checked.stdout,
          new RegExp(
            `OK: sent 3; delivered 2; explained 1 \\(${minute - 1}\\) by receiver Gap at Entry \\d+: `,
            "u"
          )
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );

  it.live(
    "PROOF-5: a loss while the receiver was listening is not excused by a Gap that comes after it",
    () =>
      Effect.gen(function* () {
        const world = yield* twoDaemons;
        const minute = currentMinute();

        yield* sendInMinute(world.sender, minute - 3);
        yield* heardCount(world.receiver, 1);

        // A loss with no Gap: the receiver is off the Channel and still hears the Ircd.
        yield* world.receiver.client.networks.part({
          params: { id: network },
          payload: { channel },
        });
        yield* eventually(
          world.receiver.status,
          (found) => found?.joined.includes(channel) === false
        );
        yield* sendInMinute(world.sender, minute - 2);
        yield* world.receiver.client.networks.join({
          params: { id: network },
          payload: { channel, remember: true },
        });
        yield* world.receiver.joined;

        // Then the receiver goes off the Network and comes back, and that is a Gap, but the
        // receiver was listening and on the Channel until it began, after the loss.
        yield* world.receiver.client.networks.disconnect({ params: { id: network } });
        yield* world.receiver.left;
        yield* world.receiver.client.networks.connect({ params: { id: network } });
        yield* world.receiver.joined;

        yield* sendInMinute(world.sender, minute - 1);
        yield* heardCount(world.receiver, 2);

        const checked = yield* checkOnce(world.receiver, world.sender);

        assert.strictEqual(checked.code, 1, checked.stdout);
        assert.include(checked.stdout, `UNEXPLAINED in minutes 1 (${minute - 2});`);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );

  it.live(
    "PROOF-5: a stop of 40 minutes fails the check, and still fails once the sender runs again",
    () =>
      Effect.gen(function* () {
        const world = yield* twoDaemons;
        const report = yield* withReport;
        const minute = currentMinute();
        const stopped = `SENDER SILENT (no send in minutes ${minute - 43}-${minute - 4})`;

        for (const earlier of [45, 44, 3, 2, 1]) {
          yield* sendInMinute(world.sender, minute - earlier);
        }

        yield* heardCount(world.receiver, 5);

        const checked = yield* checkOnce(world.receiver, world.sender, ["--report", report]);

        assert.strictEqual(checked.code, 1, checked.stdout);
        assert.include(checked.stdout, stopped);

        // The next minute is sent, and nothing is missing, but the stop is history.
        yield* sendInMinute(world.sender, minute);
        yield* heardCount(world.receiver, 6);

        const later = yield* checkOnce(world.receiver, world.sender, ["--report", report]);

        assert.strictEqual(later.code, 1, later.stdout);
        assert.include(later.stdout, stopped);
        assert.include(later.stdout, "sent 6; delivered 6");
        assert.deepStrictEqual(
          reportLines(report).map(({ pairs }) => pairs[0]?.silences),
          [`${minute - 43}-${minute - 4}`, `${minute - 43}-${minute - 4}`]
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );

  it.live(
    "PROOF-5: check fails as silent when the sender has sent nothing, though nothing is missing",
    () =>
      Effect.gen(function* () {
        const world = yield* twoDaemons;
        const checked = yield* checkOnce(world.receiver, world.sender);

        assert.strictEqual(checked.code, 1, checked.stdout);
        assert.include(checked.stdout, "SENDER SILENT (nothing sent yet)");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );

  it.live("PROOF-5: send says on stderr why it did not send, and exits non-zero", () =>
    Effect.gen(function* () {
      const world = yield* twoDaemons;

      yield* world.sender.client.networks.disconnect({ params: { id: network } });
      yield* world.sender.left;

      const notInSession = yield* sendOnce(world.sender);

      assert.strictEqual(notInSession.code, 1);
      assert.strictEqual(notInSession.stdout, "");
      assert.include(
        notInSession.stderr,
        `soak ${network}=${channel}: not sent, the Network has no Session`
      );
      assert.include(notInSession.stderr, "1 of 1 sends failed");

      const unreachable = `http://127.0.0.1:${yield* freePort}`;

      const refused = yield* soak(
        ["send", "--daemon", unreachable, "--pair", `${network}=${channel}`],
        {
          IIRC_KEY: world.sender.key,
        }
      );

      assert.strictEqual(refused.code, 1);
      assert.include(refused.stderr, `could not reach the Daemon at ${unreachable}`);

      const noKey = yield* soak(
        ["send", "--daemon", world.sender.url, "--pair", `${network}=${channel}`],
        {}
      );

      assert.strictEqual(noKey.code, 2);
      assert.include(noKey.stderr, "No key: set IIRC_KEY");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  );
});
