import {
  InvalidMessage,
  LaneFull,
  LineDropped,
  LogUnavailable,
  NotInSession,
  WriteFailed,
} from "@iirc/api";
import type { Status } from "@iirc/api";
import { Log, StorageFailed } from "@iirc/log";
import type { DataDirectoryLocked, Gap, LoggedMessage } from "@iirc/log";
import { privmsg } from "@iirc/protocol/outbound";
import type { Entry } from "@iirc/session/entry";
import { hostNetwork } from "@iirc/session/network";
import type { NetworkOptions, NetworkStatus, Sent } from "@iirc/session/network";
import { Recorder } from "@iirc/session/recorder";
import { Transport } from "@iirc/session/transport";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { constVoid } from "effect/Function";

import { checkTuning } from "./tuning.ts";
import type { InvalidTuning } from "./tuning.ts";

export { InvalidTuning } from "./tuning.ts";

// LOG-5 asks for a Frontend's key name here, and until keys exist there is only one.
const frontendRequest = "api";

/** The temporary shape of Configuration: exactly one Network, given at startup. */
export interface DaemonConfig {
  readonly dataDir: string;
  readonly network: NetworkOptions;
  readonly version: string;
}

/** Which page of the Log to read. */
interface Page {
  readonly after: number;
  readonly limit: number;
}

/** What a Thin Send came to, in the API's words. */
type SendResult =
  | { readonly sequence: number; readonly status: "written" }
  | { readonly status: "queued" };

type SendRefusal =
  | InvalidMessage
  | LaneFull
  | LineDropped
  | LogUnavailable
  | NotInSession
  | WriteFailed;

const toLogUnavailable = () => new LogUnavailable();

const toSendResult = (sent: Sent): SendResult =>
  sent._tag === "Written" ? { sequence: sent.sequence, status: "written" } : { status: "queued" };

// A rejected Channel's key is a Credential, so only its name leaves here (CRED-3).
const toStatus = (status: NetworkStatus, head: number | null, network: string): Status => ({
  closeReason: status.closeReason ?? null,
  consecutiveFailures: status.consecutiveFailures,
  head,
  joinFailures: status.joinFailures.map(({ connection, ...failure }) => ({
    ...failure,
    connection: connection ?? null,
  })),
  joined: status.joined,
  kicked: status.kicked,
  lagMillis: status.lagMillis ?? null,
  lanes: status.lanes,
  logFault: status.logFault ?? null,
  network,
  nextAttemptAt: status.nextAttemptAt ?? null,
  phase: status.phase,
  refusal: status.refusal ?? null,
  refused: status.refused,
  rejectedChannels: status.rejectedChannels.map(({ channel, reason }) => ({
    channel: channel.name,
    reason,
  })),
  self: status.self ?? null,
});

/** What the Daemon can do for a Frontend. */
export class Daemon extends Context.Service<
  Daemon,
  {
    readonly entries: (page: Page) => Effect.Effect<readonly Entry[], LogUnavailable>;
    /** Gaps by cursor, from every Network unless `network` names one (LIVE-10). */
    readonly gaps: (
      page: Page & { readonly network?: string }
    ) => Effect.Effect<readonly Gap[], LogUnavailable>;
    readonly messages: (page: Page) => Effect.Effect<readonly LoggedMessage[], LogUnavailable>;
    readonly send: (message: {
      readonly target: string;
      readonly text: string;
    }) => Effect.Effect<SendResult, SendRefusal>;
    readonly status: Effect.Effect<Status>;
    /**
     * Leaves the Network and records that the Daemon stopped (LIVE-9, RUN-3). Waits as
     * long as `quitWaitMillis` allows, and only the first call does anything.
     */
    readonly stop: Effect.Effect<void>;
  }
>()("@iirc/daemon/Daemon") {
  /**
   * Records this start, then hosts the Network for as long as the Layer lives. Closing
   * the Layer stops it, if nothing has yet, so the Log outlasts the Daemon's last Entry.
   * @param config - The Network to stay on.
   * @returns The Daemon, already connecting.
   */
  static readonly layer = (
    config: DaemonConfig
  ): Layer.Layer<Daemon, InvalidTuning | StorageFailed, Log | Recorder | Transport> =>
    Layer.effect(
      Daemon,
      Effect.gen(function* () {
        yield* checkTuning(config.network.tuning);

        const log = yield* Log;
        const { record } = yield* Recorder;
        const { network, version } = config;

        yield* record([{ _tag: "Daemon", phase: "started", version }], constVoid).pipe(
          Effect.mapError(({ cause }) => new StorageFailed({ cause }))
        );

        const scope = yield* Scope.fork(yield* Effect.scope);
        const host = yield* Scope.provide(hostNetwork(network), scope);

        const stop = yield* Effect.cached(
          Scope.close(scope, Exit.void).pipe(
            Effect.andThen(record([{ _tag: "Daemon", phase: "stopped", version }], constVoid)),
            Effect.catchTag("RecordFailed", (failed) =>
              Effect.logError("The Daemon's stop could not be recorded", failed)
            )
          )
        );

        yield* Effect.addFinalizer(() => stop);

        return {
          entries: (page) => Effect.mapError(log.entries(page), toLogUnavailable),
          gaps: (page) => Effect.mapError(log.gaps(page), toLogUnavailable),
          messages: (page) => Effect.mapError(log.messages(page), toLogUnavailable),
          send: Effect.fnUntraced(function* ({ target, text }) {
            const built = privmsg(target, text);

            if (built._tag === "Rejected") {
              return yield* new InvalidMessage({ reason: built.reason });
            }

            return yield* host.send(built.line, frontendRequest).pipe(
              Effect.map(toSendResult),
              Effect.catchTags({
                LaneFull: ({ lane }) => Effect.fail(new LaneFull({ lane })),
                LineDropped: ({ reason }) => Effect.fail(new LineDropped({ reason })),
                NotInSession: ({ phase }) => Effect.fail(new NotInSession({ phase })),
                RecordFailed: () => Effect.fail(new LogUnavailable()),
                WriteFailed: ({ reason }) => Effect.fail(new WriteFailed({ reason })),
              })
            );
          }),
          // It is how a Frontend hears of a fault in the Log, so a fault must not stop it.
          status: Effect.gen(function* () {
            const status = yield* host.status;
            const head = yield* Effect.orElseSucceed(log.head, () => null);

            return toStatus(status, head, network.id);
          }),
          stop,
        };
      })
    );

  /**
   * Makes the Network the first thing to stop. Everything that serves a Frontend depends
   * on the Daemon, so closing in reverse order would stop those first, and a Send on a
   * stalled socket would then hold up `QUIT`. Stopped first, that Send is answered at
   * once. Provide what serves Frontends to this, so that it is built after them.
   */
  static readonly stopsFirst: Layer.Layer<never, never, Daemon> = Layer.effectDiscard(
    Effect.gen(function* () {
      const { stop } = yield* Daemon;

      yield* Effect.addFinalizer(() => stop);
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
): Layer.Layer<Daemon, DataDirectoryLocked | InvalidTuning | StorageFailed> =>
  Daemon.layer(config).pipe(
    Layer.provide(Log.layer({ dataDir: config.dataDir })),
    Layer.provide(transport)
  );
