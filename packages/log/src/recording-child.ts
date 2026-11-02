import { writeSync } from "node:fs";

import { BunRuntime } from "@effect/platform-bun";
import { Recorder } from "@iirc/session/recorder";
import { attemptInput } from "@iirc/session/testing";
import { Array as Arr, Effect } from "effect";

import { Log } from "./log.ts";

// Run by the kill tests: records Entries until killed, and reports each commit.
// The report goes straight to the pipe, so anything it says has really happened.

const stdout = 1;
const dataDir = process.argv[2] ?? "";
const encoder = new TextEncoder();

const line = (text: string, direction: "inbound" | "outbound") =>
  ({
    _tag: "Line",
    bytes: encoder.encode(text),
    connection: 1,
    direction,
    network: "libera",
  }) as const;

const program = Effect.gen(function* () {
  const { record } = yield* Recorder;

  const attempt = {
    _tag: "Connection",
    ircd: { host: "irc.example", port: 6697, tls: true },
    network: "libera",
    nicks: ["alice"],
    ...attemptInput,
    phase: "attempt",
  } as const;

  // The first Entry of a fresh Log, so its sequence is 1.
  const opened = {
    _tag: "Connection",
    connection: 1,
    ircd: attempt.ircd,
    network: "libera",
    phase: "opened",
  } as const;

  yield* record([attempt, opened, line(":ircd 001 alice :Welcome", "inbound")], Array.isArray);

  // Three Lines from one socket read, which must survive whole or not at all.
  const batch = [
    line(":bob!u@h PRIVMSG #iirc :one", "inbound"),
    line(":bob!u@h PRIVMSG #iirc :two", "inbound"),
    line("PRIVMSG #iirc :three", "outbound"),
  ] as const;

  // Only `record` returning means committed, because `within` runs before that.
  const commit = record(batch, (recorded) => Arr.lastNonEmpty(recorded).sequence).pipe(
    Effect.tap((sequence) =>
      Effect.sync(() => {
        writeSync(stdout, `${sequence}\n`);
      })
    )
  );

  return yield* Effect.forever(commit);
}).pipe(Effect.provide(Log.layer({ dataDir })));

BunRuntime.runMain(program);
