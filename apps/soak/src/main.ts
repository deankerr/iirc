#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { version } from "../package.json";
import { check } from "./check.ts";
import { failed, reportedOnStderr, usageExitCode } from "./command-failed.ts";
import { clientOf } from "./log-reading.ts";
import { CheckPairText, SendPairText } from "./pair.ts";
import { send } from "./send.ts";
import { defaultTolerances } from "./verdict.ts";

// API-1: this is a Frontend like any other. It reaches a Daemon only through its API,
// with a key, and knows nothing a script could not. Keys come only from the environment,
// so that they never show in `ps`.

const Url = Schema.String.check(
  Schema.makeFilter((text) => URL.canParse(text) || "must be a URL, such as http://127.0.0.1:7667")
);

const daemonUrl = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withSchema(Url), Flag.withDescription(description));

const keyIn = Effect.fnUntraced(function* (name: string) {
  const key = yield* Config.option(Config.Redacted(name)).pipe(Effect.orDie);

  return Option.isSome(key) && Redacted.value(key.value) !== ""
    ? key.value
    : yield* failed(
        `No key: set ${name} to an API key of the Daemon. It is read only from the environment.`,
        usageExitCode
      );
});

const sendCommand = Command.make(
  "send",
  {
    daemon: daemonUrl("daemon", "The sender's API, such as http://127.0.0.1:7667"),
    pairs: Flag.String("pair").pipe(
      Flag.withSchema(SendPairText),
      Flag.withDescription("<networkId>=<target>: where to send the next counted Message"),
      Flag.atLeast(1)
    ),
  },
  Effect.fnUntraced(function* ({ daemon, pairs }) {
    const client = yield* clientOf(daemon, yield* keyIn("IIRC_KEY"));

    yield* send(client, daemon, pairs);
  }, reportedOnStderr)
).pipe(
  Command.withDescription(
    "Send one counted Message to each pair, numbered from the sender's own Log (PROOF-5). Key: IIRC_KEY"
  )
);

const minutes = 60_000;
const seconds = 1000;

const positive = Schema.Finite.check(Schema.isGreaterThan(0));
const notNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const checkCommand = Command.make(
  "check",
  {
    pairs: Flag.String("pair").pipe(
      Flag.withSchema(CheckPairText),
      Flag.withDescription("<senderNetworkId>:<receiverNetworkId>=<target>"),
      Flag.atLeast(1)
    ),
    receiver: daemonUrl("receiver", "The receiver's API (key: IIRC_RECEIVER_KEY)"),
    report: Flag.String("report").pipe(
      Flag.withDescription("A file to add one line of JSON to for each run"),
      Flag.optional
    ),
    sender: daemonUrl("sender", "The sender's API (key: IIRC_SENDER_KEY)"),
    settle: Flag.Finite("settle").pipe(
      Flag.withSchema(notNegative),
      Flag.withDescription("Seconds a Message is given to arrive before it counts as missing"),
      Flag.withDefault(defaultTolerances.settleMillis / seconds)
    ),
    silence: Flag.Finite("silence").pipe(
      Flag.withSchema(positive),
      Flag.withDescription("Minutes the sender may go without sending before that is a failure"),
      Flag.withDefault(10)
    ),
  },
  Effect.fnUntraced(function* (flags) {
    const sender = {
      client: yield* clientOf(flags.sender, yield* keyIn("IIRC_SENDER_KEY")),
      url: flags.sender,
    };

    const receiver = {
      client: yield* clientOf(flags.receiver, yield* keyIn("IIRC_RECEIVER_KEY")),
      url: flags.receiver,
    };

    yield* check({
      pairs: flags.pairs,
      receiver,
      report: flags.report,
      sender,
      tolerances: {
        ...defaultTolerances,
        settleMillis: flags.settle * seconds,
        silenceMillis: flags.silence * minutes,
      },
    });
  }, reportedOnStderr)
).pipe(
  Command.withDescription(
    "Read both Daemons' Logs and judge every pair; exit non-zero on anything unexplained (PROOF-5)"
  )
);

const soak = Command.make("iirc-soak").pipe(
  Command.withDescription("The soak test of PROOF-5, as a Frontend of two Daemons"),
  Command.withSubcommands([sendCommand, checkCommand])
);

Command.run(soak, { version }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
