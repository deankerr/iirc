import { InvalidMessage, NotInSession } from "@iirc/api";
import type { NetworkInput } from "@iirc/lifecycle";
import { Log, StorageFailed } from "@iirc/log";
import type { DataDirectoryLocked, LoggedMessage } from "@iirc/log";
import { privmsg } from "@iirc/protocol/outbound";
import type { Entry, Ircd, NetworkId } from "@iirc/session/entry";
import { hostNetwork } from "@iirc/session/network";
import { Recorder } from "@iirc/session/recorder";
import { Transport } from "@iirc/session/transport";
import { Context, Effect, Layer } from "effect";
import { constVoid } from "effect/Function";

// LOG-5 asks for a Frontend's key name here, and until keys exist there is only one.
const frontendRequest = "api";

/** The temporary shape of Configuration: exactly one Network, given at startup. */
export interface DaemonConfig {
  readonly dataDir: string;
  readonly input: NetworkInput;
  readonly ircd: Ircd;
  readonly network: NetworkId;
  readonly version: string;
}

/** Which page of the Log to read. */
interface Page {
  readonly after: number;
  readonly limit: number;
}

/**
 * What the Daemon can do for a Frontend. Reads die rather than fail, because the API
 * has no typed error for a broken Log and a Frontend can do nothing about one.
 */
export class Daemon extends Context.Service<
  Daemon,
  {
    readonly entries: (page: Page) => Effect.Effect<readonly Entry[]>;
    readonly messages: (page: Page) => Effect.Effect<readonly LoggedMessage[]>;
    readonly send: (message: {
      readonly target: string;
      readonly text: string;
    }) => Effect.Effect<void, InvalidMessage | NotInSession>;
    readonly status: Effect.Effect<{
      readonly closeReason: string | null;
      readonly head: number;
      readonly network: NetworkId;
      readonly phase: NotInSession["phase"];
    }>;
  }
>()("@iirc/daemon/Daemon") {
  /**
   * Records this start, then hosts the Network for as long as the Layer lives.
   * @param config - The Network to stay on.
   * @returns The Daemon, already connecting.
   */
  static readonly layer = (
    config: DaemonConfig
  ): Layer.Layer<Daemon, StorageFailed, Log | Recorder | Transport> =>
    Layer.effect(
      Daemon,
      Effect.gen(function* () {
        const log = yield* Log;
        const { record } = yield* Recorder;
        const { input, ircd, network, version } = config;

        yield* record([{ _tag: "Daemon", phase: "started", version }], constVoid).pipe(
          Effect.mapError(({ cause }) => new StorageFailed({ cause }))
        );

        const host = yield* hostNetwork({ id: network, input, ircd });

        return {
          entries: (page) => Effect.orDie(log.entries(page)),
          messages: (page) => Effect.orDie(log.messages(page)),
          send: Effect.fnUntraced(function* ({ target, text }) {
            const built = privmsg(target, text);

            if (built._tag === "Rejected") {
              return yield* new InvalidMessage({ reason: built.reason });
            }

            return yield* host.send(built.line, frontendRequest).pipe(
              Effect.catchTags({
                NotInSession: ({ phase }) => Effect.fail(new NotInSession({ phase })),
                RecordFailed: (failed) => Effect.die(failed),
              })
            );
          }),
          status: Effect.gen(function* () {
            const { closeReason, phase } = yield* host.status;
            const head = yield* log.head;

            return { closeReason: closeReason ?? null, head, network, phase };
          }).pipe(Effect.orDie),
        };
      })
    );
}

/**
 * The Daemon and everything under it, with no HTTP and no argv. Provide it outside
 * `HttpRouter.serve`, which forks the MemoMap, or the Log is built twice and locks
 * itself out.
 * @param config - The Network to stay on, and where the Log lives.
 * @param transport - How to reach an Ircd, which a test can replace.
 * @returns The Daemon, holding the data directory for as long as it lives.
 */
export const DaemonCore = (
  config: DaemonConfig,
  transport: Layer.Layer<Transport> = Transport.layer
): Layer.Layer<Daemon, DataDirectoryLocked | StorageFailed> =>
  Daemon.layer(config).pipe(
    Layer.provide(Log.layer({ dataDir: config.dataDir })),
    Layer.provide(transport)
  );
