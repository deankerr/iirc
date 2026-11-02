import { writeSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer } from "effect";

import { Log } from "./log.ts";

// Run by `log.test.ts` inside a namespace whose data directory is a tmpfs filled to the
// last byte: opens the Log there and says, as one JSON line, how that went.

const dataDir = process.argv[2] ?? "";
const stdout = 1;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : JSON.stringify(cause);

const exit = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(Log.layer({ dataDir }))).pipe(Effect.provide(BunServices.layer))
);

const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;

writeSync(
  stdout,
  `${JSON.stringify(
    failure === undefined || failure._tag === "None"
      ? { opened: Exit.isSuccess(exit) }
      : {
          reason:
            failure.value._tag === "StorageFailed"
              ? describe(failure.value.cause)
              : failure.value._tag,
          tag: failure.value._tag,
        }
  )}\n`
);
