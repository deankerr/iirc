import {
  apiVersion,
  BackupFailed,
  ChannelNotFound,
  CredentialNotFound,
  EntryAlreadyRedacted,
  EntryNotFound,
  EntryNotRedactable,
  InvalidMessage,
  InvalidRequest,
  KeyExists,
  KeyNotFound,
  LaneFull,
  LineDropped,
  LogUnavailable,
  NetworkExists,
  NetworkNotFound,
  NotInSession,
  ReaderBusy,
  ReadTimedOut,
  Stopping,
  WriteFailed,
} from "@iirc/api";
import type {
  CredentialsUnavailable,
  KeyScope,
  NetworkSettings,
  NetworkStatus as NetworkState,
  Status,
} from "@iirc/api";
import { Log, LogReader, longestReadMillis, StorageFailed } from "@iirc/log";
import type {
  Backup,
  DataDirectoryLocked,
  LogTooNew,
  EntryQuery,
  Gap,
  LoggedMessage,
  NetworkPage,
  ReaderBusy as ReaderQueueFull,
  ReadTimedOut as ReaderTimedOut,
} from "@iirc/log";
import { part as partLine, privmsg } from "@iirc/protocol/outbound";
import type { Outbound, OutboundLine } from "@iirc/protocol/outbound";
import { joinSensitive, keyedJoins } from "@iirc/session/credentials";
import type { Entry, NetworkId } from "@iirc/session/entry";
import { hostNetwork } from "@iirc/session/network";
import type {
  NetworkHost,
  NetworkOptions,
  NetworkSettings as HostSettings,
  NetworkStatus,
  Secrets,
  Sensitive,
  Sent,
} from "@iirc/session/network";
import { Recorder } from "@iirc/session/recorder";
import { channelKey } from "@iirc/session/standing";
import { Transport } from "@iirc/session/transport";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Predicate,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Duration, Redacted } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";
import { constVoid } from "effect/Function";

import type { Change } from "./change.ts";
import { keyNameFor } from "./channel-keys.ts";
import { droppedChannels } from "./configuration.ts";
import type { Configuration, ConfiguredNetwork } from "./configuration.ts";
import { Credentials } from "./credentials.ts";
import type { CredentialsUnreadable, CredentialStore, Keyring } from "./credentials.ts";
import { findKey, hashKey, keyCrypto, newKey } from "./keys.ts";
import { readConfiguration, recordChange, recordRedaction } from "./recorded.ts";
import type { UndecodableChange } from "./recorded.ts";
import { tuningOf } from "./tuning.ts";

export { createLocalKey } from "./local-key.ts";

export type { LocalKeyOptions } from "./local-key.ts";

export { UndecodableChange } from "./recorded.ts";

/**
 * How long serving may wait for the requests still in flight once the Daemon has stopped.
 * The Networks stop before serving does ({@link Daemon.stopsFirst}), which answers every
 * Send, and a stopped Daemon refuses every Change at once, so only a read can still be
 * waiting, and a read gives up within {@link longestReadMillis}. No Network's Tuning
 * changes this, because by then every `QUIT` wait is over.
 */
export const frontendWaitMillis = longestReadMillis + 500;

/** What the Daemon needs to start. Everything else is in the Log (CONF-4). */
export interface DaemonConfig {
  readonly dataDir: string;
  readonly version: string;
}

/** What a Line a Frontend asked for came to, in the API's words (API-9). */
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

type Recording = LogUnavailable | Stopping;

/** The sequence of the Change an operation recorded. */
interface Changed {
  readonly change: number;
}

/**
 * What a Join produced (API-9): its Change if remembered, or else its `JOIN`, which is
 * skipped when Self is already in the Channel, so that nothing sends a duplicate (LOG-5).
 */
type Joined =
  | Changed
  | { readonly line: SendResult }
  | { readonly line: { readonly reason: "AlreadyJoined"; readonly status: "skipped" } };

/**
 * What a Part produced (API-9). Once its Change is recorded, a `PART` that fails is part
 * of the answer, because the Change stands.
 */
type Parted =
  | (Changed & {
      readonly line?: SendResult | { readonly error: LineFailure; readonly status: "failed" };
    })
  | { readonly line: SendResult };

/** Why a Line that was valid did not leave. */
type LineFailure = Exclude<SendRefusal, InvalidMessage>;

/** A Network's Configuration beside what is true of it now. */
interface NetworkView {
  readonly settings: NetworkSettings;
  readonly status: NetworkState;
}

/** Who asked, which every Change and every Line sent on their behalf names (LOG-5). */
type By = string;

// LOG-5: the cause of a Line a Frontend asked for.
const causeOf = (by: By) => `key:${by}`;

// A read past its budget says so, because the remedy is to ask for less, a read that
// never left the queue says so, because the remedy is to wait, and any other failure is
// the Log's (LOG-11).
const fromReader = <A>(read: Effect.Effect<A, ReaderQueueFull | ReaderTimedOut | StorageFailed>) =>
  Effect.catchTags(read, {
    ReadTimedOut: ({ budgetMillis }) => Effect.fail(new ReadTimedOut({ budgetMillis })),
    ReaderBusy: ({ waitedMillis }) => Effect.fail(new ReaderBusy({ waitedMillis })),
    StorageFailed: () => Effect.fail(new LogUnavailable()),
  });

// What a failure says of itself, as the reason a Frontend is given.
const reasonOf = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);

const toSendResult = (sent: Sent): SendResult =>
  sent._tag === "Written" ? { sequence: sent.sequence, status: "written" } : { status: "queued" };

// A Join with no key has nothing to build in.
const noSecrets: Secrets = new Map();

const byId = (configuration: Configuration) =>
  [...configuration.networks.values()].toSorted((one, other) =>
    one.settings.id < other.settings.id ? -1 : 1
  );

// What a host runs with: the Channels wanted, which are those with autojoin on, each with
// its key by name and the Change that last wanted it, the whole Tuning, and every
// Credential, as the same Map until one changes (CONF-2, LIVE-8, LOG-6).
const hostSettings = (
  { retrySince, settings, wantedSince }: ConfiguredNetwork,
  secrets: Secrets
): HostSettings => ({
  channels: settings.channels.flatMap(({ autojoin, key, name, rejoinOnKick }) => {
    const since = wantedSince.get(channelKey(name));

    return autojoin
      ? [
          {
            name,
            rejoinOnKick,
            ...(key !== undefined && { key }),
            ...(since !== undefined && { since }),
          },
        ]
      : [];
  }),
  connectCommands: settings.connectCommands,
  credentials: settings.credentials,
  enabled: settings.enabled,
  identity: settings.identity,
  ircds: settings.ircds,
  quitReason: settings.quitReason,
  retrySince,
  secrets,
  services: settings.services,
  tuning: tuningOf(settings.tuning),
});

const toNetworkState = ({ id, name }: NetworkSettings, status: NetworkStatus): NetworkState => ({
  closeReason: status.closeReason ?? null,
  consecutiveFailures: status.consecutiveFailures,
  enabled: status.enabled,
  id,
  joinFailures: status.joinFailures.map(({ connection, ...failure }) => ({
    ...failure,
    connection: connection ?? null,
  })),
  joined: status.joined,
  kicked: status.kicked,
  lagMillis: status.lagMillis ?? null,
  lanes: status.lanes,
  logFault: status.logFault ?? null,
  login: { state: status.login.state, text: status.login.text ?? null },
  missingCredentials: status.missingCredentials,
  name,
  nextAttemptAt: status.nextAttemptAt ?? null,
  phase: status.phase,
  rejectedChannels: status.rejectedChannels.map(({ channel, reason }) => ({
    channel: channel.name,
    reason,
  })),
  self: status.self ?? null,
});

// A Network whose host has not started yet, which only a read that races its Change sees.
const unhosted = ({ enabled, id, name }: NetworkSettings): NetworkState => ({
  closeReason: null,
  consecutiveFailures: 0,
  enabled,
  id,
  joinFailures: [],
  joined: [],
  kicked: [],
  lagMillis: null,
  lanes: { background: 0, control: 0, interactive: 0 },
  logFault: null,
  login: { state: "none", text: null },
  missingCredentials: [],
  name,
  nextAttemptAt: null,
  phase: "idle",
  rejectedChannels: [],
  self: null,
});

const without = <A>(held: ReadonlyMap<NetworkId, A>, id: NetworkId) => {
  const remaining = new Map(held);

  remaining.delete(id);

  return remaining;
};

const requireNetwork = (current: Configuration, id: NetworkId) => {
  const network = current.networks.get(id);

  return network === undefined
    ? Effect.fail(new NetworkNotFound({ network: id }))
    : Effect.succeed(network);
};

const sendThrough = (
  host: NetworkHost,
  line: OutboundLine,
  by: By,
  sensitive?: Sensitive
): Effect.Effect<SendResult, LineFailure> =>
  host.send(line, causeOf(by), sensitive).pipe(
    Effect.map(toSendResult),
    Effect.catchTags({
      LaneFull: ({ lane }) => Effect.fail(new LaneFull({ lane })),
      LineDropped: ({ reason }) => Effect.fail(new LineDropped({ reason })),
      NotInSession: ({ phase }) => Effect.fail(new NotInSession({ phase })),
      RecordFailed: () => Effect.fail(new LogUnavailable()),
      WriteFailed: ({ reason }) => Effect.fail(new WriteFailed({ reason })),
    })
  );

const built = (outbound: Outbound) =>
  outbound._tag === "Rejected"
    ? Effect.fail(new InvalidMessage({ reason: outbound.reason }))
    : Effect.succeed(outbound.line);

/** What the Daemon can do for a Frontend, each on behalf of a key. */
export class Daemon extends Context.Service<
  Daemon,
  {
    /** Adds a Network, which is hosted at once (CONF-3). */
    readonly addNetwork: (
      by: By,
      settings: NetworkSettings
    ) => Effect.Effect<Changed, InvalidRequest | NetworkExists | Recording>;
    /** Whose key was presented, if anyone's (AUTH-2). */
    readonly authorize: (
      presented: string
    ) => Effect.Effect<{ readonly name: string; readonly scope: KeyScope } | undefined>;
    /** Backs up the Log into `backups/` in the data directory, while it runs (RUN-2). */
    readonly backup: Effect.Effect<Backup, BackupFailed>;
    /** Replaces a Network's settings whole. Ircds, Identity, and Tuning apply next time. */
    readonly changeNetwork: (
      by: By,
      id: NetworkId,
      settings: NetworkSettings
    ) => Effect.Effect<Changed, InvalidRequest | NetworkNotFound | Recording>;
    /** All of Configuration, ordered by ID (CONF-6). */
    readonly configuration: Effect.Effect<{ readonly networks: readonly NetworkSettings[] }>;
    /** Enables a Network and retries now (LIVE-4). */
    readonly connect: (
      by: By,
      id: NetworkId
    ) => Effect.Effect<Changed, NetworkNotFound | Recording>;
    /** Every Credential's name and when it was set, and where they are kept (CRED-2). */
    readonly credentials: Effect.Effect<{
      readonly credentials: readonly { readonly name: string; readonly set: number }[];
      readonly store: CredentialStore;
    }>;
    /**
     * Deletes a Credential, and then records that it did (CRED-1). A Credential the Log
     * says is set and the store does not hold is deleted too, which only a crash between
     * the two writes leaves, so that asking again brings them back in line.
     */
    readonly deleteCredential: (
      by: By,
      name: string
    ) => Effect.Effect<Changed, CredentialNotFound | CredentialsUnavailable | Recording>;
    /** Creates a key, which is returned once and never again (AUTH-2). */
    readonly createKey: (
      by: By,
      key: { readonly name: string; readonly scope: KeyScope }
    ) => Effect.Effect<
      Changed & { readonly key: string; readonly name: string; readonly scope: KeyScope },
      KeyExists | Recording
    >;
    /** Disables a Network, which leaves by choice (LIVE-9). */
    readonly disconnect: (
      by: By,
      id: NetworkId
    ) => Effect.Effect<Changed, NetworkNotFound | Recording>;
    /** Entries by cursor, from every Network and of every kind unless the query narrows it. */
    readonly entries: (
      query: EntryQuery
    ) => Effect.Effect<readonly Entry[], LogUnavailable | ReaderBusy | ReadTimedOut>;
    /** Gaps by cursor, from every Network unless `network` names one (LIVE-10). */
    readonly gaps: (
      query: NetworkPage
    ) => Effect.Effect<readonly Gap[], LogUnavailable | ReaderBusy | ReadTimedOut>;
    /**
     * Joins a Channel (CONF-5). Remembered, it records the Channel as wanted, which a host
     * joins with or without a Session. Not remembered, it sends `JOIN` now, which needs one.
     */
    readonly join: (
      by: By,
      id: NetworkId,
      join: {
        readonly channel: string;
        readonly key?: Redacted.Redacted;
        readonly remember: boolean;
      }
    ) => Effect.Effect<Joined, CredentialsUnavailable | NetworkNotFound | Recording | SendRefusal>;
    /** The keys there are, never the keys themselves. */
    readonly keys: Effect.Effect<
      readonly { readonly created: number; readonly name: string; readonly scope: KeyScope }[]
    >;
    /** Messages by cursor, from every Network unless `network` names one. */
    readonly messages: (
      query: NetworkPage
    ) => Effect.Effect<readonly LoggedMessage[], LogUnavailable | ReaderBusy | ReadTimedOut>;
    /** One Network's Configuration and status. */
    readonly network: (id: NetworkId) => Effect.Effect<NetworkView, NetworkNotFound>;
    /** Every Network's Configuration and status, ordered by ID. */
    readonly networks: Effect.Effect<readonly NetworkView[]>;
    /**
     * Parts a Channel (CONF-5): takes it out of Configuration if it is there, and sends
     * `PART` if Self is in it now. Once the Change is recorded, a `PART` that fails is in
     * the answer, not a refusal.
     */
    readonly part: (
      by: By,
      id: NetworkId,
      part: { readonly channel: string; readonly reason?: string }
    ) => Effect.Effect<Parted, ChannelNotFound | NetworkNotFound | Recording | SendRefusal>;
    /**
     * Removes a Network, which says `QUIT` and stays off (LIVE-9). It answers once the
     * host has gone, and holds up no other Change while it goes.
     */
    readonly removeNetwork: (
      by: By,
      id: NetworkId
    ) => Effect.Effect<Changed, NetworkNotFound | Recording>;
    /**
     * Empties the bytes of the Line or Dropped Entry at `sequence`, recording who did in
     * the same transaction, and derives every table again (LOG-7).
     */
    readonly redact: (
      by: By,
      sequence: number
    ) => Effect.Effect<
      Changed,
      EntryAlreadyRedacted | EntryNotFound | EntryNotRedactable | Recording
    >;
    /** Replaces all of Configuration as one Change, as an import does (CONF-6). */
    readonly replaceConfiguration: (
      by: By,
      networks: readonly NetworkSettings[]
    ) => Effect.Effect<Changed, InvalidRequest | Recording>;
    /** Revokes a key, which stops working on its next request (AUTH-2). */
    readonly revokeKey: (by: By, name: string) => Effect.Effect<Changed, KeyNotFound | Recording>;
    /**
     * Sets or replaces a Credential, and then records that it did, by name alone (CRED-1).
     * Kept first, because a value with no Change is harmless, and a Change that claims a
     * value which was never kept would mislead.
     */
    readonly setCredential: (
      by: By,
      name: string,
      value: Redacted.Redacted
    ) => Effect.Effect<Changed, CredentialsUnavailable | Recording>;
    /** Sends one `PRIVMSG` (API-9). */
    readonly send: (
      by: By,
      message: { readonly network: NetworkId; readonly target: string; readonly text: string }
    ) => Effect.Effect<SendResult, NetworkNotFound | SendRefusal>;
    readonly status: Effect.Effect<Status>;
    /**
     * Leaves every Network at once and records that the Daemon stopped (LIVE-9, RUN-3).
     * Each waits as long as its `quitWaitMillis` allows, and only the first call does
     * anything.
     */
    readonly stop: Effect.Effect<void>;
  }
>()("@iirc/daemon/Daemon") {
  /**
   * Records this start, reads Configuration from the Log, and hosts every Network in it
   * for as long as the Layer lives. Closing the Layer stops it, if nothing has yet, so the
   * Log outlasts the Daemon's last Entry.
   * @param config - Where the Log is, and the Daemon's version.
   * @returns The Daemon, already connecting.
   */
  static readonly layer = (
    config: DaemonConfig
  ): Layer.Layer<
    Daemon,
    StorageFailed | UndecodableChange,
    Credentials | Digest.Digest | Log | LogReader | Recorder | SecureRandom.SecureRandom | Transport
  > =>
    Layer.effect(
      Daemon,
      Effect.gen(function* () {
        const log = yield* Log;
        const reader = yield* LogReader;
        const credentials = yield* Credentials;
        const { record } = yield* Recorder;
        const { version } = config;

        // CONF-1: what the Log says, or nothing at all. Nothing else appends yet, so this
        // reads on the writer, with no budget to run out of however long the history.
        const configuration = yield* SubscriptionRef.make(yield* readConfiguration(log));

        yield* record([{ _tag: "Daemon", phase: "started", version }], constVoid).pipe(
          Effect.mapError(({ cause }) => new StorageFailed({ cause }))
        );

        // Only the Daemon appends Changes, one at a time, so an operation that checks itself
        // against Configuration, records, and folds under this permit cannot be overtaken.
        const changing = yield* Semaphore.make(1);
        const stopping = yield* Ref.make(false);
        const hostsScope = yield* Scope.fork(yield* Effect.scope);
        const fibers = yield* Scope.provide(FiberMap.make<NetworkId>(), hostsScope);
        const hosts = yield* Ref.make<ReadonlyMap<NetworkId, NetworkHost>>(new Map());

        // The hosts of removed Networks that are still saying `QUIT`, each done once gone.
        const leaving = yield* Ref.make<ReadonlyMap<NetworkId, Deferred.Deferred<undefined>>>(
          new Map()
        );

        // A host is started by whichever operation added its Network, and runs on what the
        // Daemon was built with.
        const hostContext = yield* Effect.context<Recorder | Transport>();
        const keyContext = yield* Effect.context<Digest.Digest | SecureRandom.SecureRandom>();

        // A host reads its settings whenever it decides something, and wakes only for a
        // Change to its own Network, which the fold gives a new object. A Credential it
        // refers to changing is one of those (CRED-1).
        const optionsFor = (network: ConfiguredNetwork): NetworkOptions => {
          const { id } = network.settings;
          let last: HostSettings | undefined;

          return {
            changes: SubscriptionRef.changes(configuration).pipe(
              Stream.map(({ networks }) => networks.get(id)),
              Stream.changesWith((one, other) => one === other)
            ),
            id,
            // A removed Network's host stops once Configuration has dropped it, and until it
            // has gone it finds its Network as it last was, but disabled, so it acts on
            // nothing the Owner removed.
            settings: Effect.gen(function* () {
              const found = (yield* SubscriptionRef.get(configuration)).networks.get(id);
              const secrets = yield* credentials.all;

              last =
                found === undefined
                  ? { ...(last ?? hostSettings(network, secrets)), enabled: false, secrets }
                  : hostSettings(found, secrets);

              return last;
            }),
          };
        };

        const startHost = Effect.fnUntraced(function* (network: ConfiguredNetwork) {
          const { id } = network.settings;
          const ready = yield* Deferred.make<undefined>();

          // `hostNetwork` waits for its `QUIT` in a finalizer that can be cut short, which on
          // a fiber being interrupted it would be at once. So its Scope is closed on a fiber
          // of its own, which nothing interrupts, and the host's fiber waits for that.
          const fiber = yield* FiberMap.run(
            fibers,
            id,
            Effect.gen(function* () {
              const scope = yield* Scope.make();

              return yield* Effect.gen(function* () {
                const host = yield* Scope.provide(hostNetwork(optionsFor(network)), scope);

                yield* Ref.update(hosts, (held) => new Map(held).set(id, host));
                yield* Deferred.succeed(ready, undefined);

                return yield* Effect.never;
              }).pipe(
                Effect.onExit(() =>
                  Effect.flatMap(Effect.forkDetach(Scope.close(scope, Exit.void)), Fiber.await)
                )
              );
            }).pipe(Effect.provideContext(hostContext))
          );

          yield* Effect.raceFirst(Deferred.await(ready), Fiber.await(fiber));
        });

        // Closing a host's Scope says `QUIT` and waits for it (LIVE-9). That runs on a fiber
        // of its own, so the Change that removed the Network holds the permit no longer
        // than it takes to record. Nothing interrupts it, so a stopping Daemon, which
        // closes `hostsScope`, waits for it too.
        const stopHost = Effect.fnUntraced(function* (id: NetworkId) {
          const gone = yield* Deferred.make<undefined>();

          yield* Ref.update(hosts, (held) => without(held, id));
          yield* Ref.update(leaving, (held) => new Map(held).set(id, gone));
          yield* FiberMap.remove(fibers, id).pipe(
            Effect.ensuring(
              Effect.andThen(
                Deferred.succeed(gone, undefined),
                Ref.update(leaving, (held) => (held.get(id) === gone ? without(held, id) : held))
              )
            ),
            Effect.forkIn(hostsScope, { uninterruptible: true })
          );

          return gone;
        });

        // A Network added again under an ID whose old host is still leaving waits for it,
        // so that two hosts never share an ID.
        const untilLeft = (id: NetworkId) =>
          Effect.flatMap(Ref.get(leaving), (held) => {
            const gone = held.get(id);

            return gone === undefined ? Effect.void : Deferred.await(gone);
          });

        yield* Effect.forEach(
          byId(yield* SubscriptionRef.get(configuration)),
          (network) => startHost(network),
          { discard: true }
        );

        // Recorded, folded, and published under the permit. Hosts that are gone start to
        // stop once Configuration has dropped them, and new ones start once it has them,
        // so a host always finds its own Network. The operation answers once the gone
        // hosts have said `QUIT`, but the permit is free by then (LIVE-9). `decide` may
        // write elsewhere before it names its Change, as a Credential does, so that what
        // it wrote and the Change that records it are in the same order as every other.
        // `write` records the Change, which is an append unless the Change edits the Log
        // too, as a redaction does.
        //
        // From `decide` to the last host started, nothing can interrupt it. A Change that
        // was recorded and never published would leave Configuration behind the Log, and
        // a Credential that was kept and never recorded would leave a value no Change
        // names. Only waiting for the permit can be cancelled, and every wait inside is
        // bounded: a Credential's write, and an old host's `QUIT`.
        const commitWith = <E, C extends Change, W>(
          by: By,
          decide: (current: Configuration) => Effect.Effect<C, E>,
          write: (
            before: Configuration,
            by: By,
            change: C
          ) => Effect.Effect<{ readonly after: Configuration; readonly sequence: number }, W>
        ) =>
          Effect.gen(function* () {
            const committed = yield* changing.withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (yield* Ref.get(stopping)) {
                    return yield* new Stopping();
                  }

                  const before = yield* SubscriptionRef.get(configuration);
                  const change = yield* decide(before);

                  const { after, sequence } = yield* write(before, by, change);

                  yield* SubscriptionRef.set(configuration, after);

                  const gone = yield* Effect.forEach(
                    [...before.networks.keys()].filter((id) => !after.networks.has(id)),
                    stopHost
                  );

                  yield* Effect.forEach(
                    [...after.networks.values()].filter(
                      ({ settings }) => !before.networks.has(settings.id)
                    ),
                    (network) => Effect.andThen(untilLeft(network.settings.id), startHost(network)),
                    { discard: true }
                  );

                  return { after, before, gone, sequence };
                })
              )
            );

            yield* Effect.forEach(committed.gone, Deferred.await, { discard: true });

            return committed;
          });

        const appendChange = (before: Configuration, by: By, change: Change) =>
          recordChange(record, before, by, change).pipe(
            Effect.mapError(() => new LogUnavailable())
          );

        const commit = <E>(by: By, decide: (current: Configuration) => Effect.Effect<Change, E>) =>
          commitWith(by, decide, appendChange);

        // Stores a Credential, then records that it did, by name alone (CRED-1). Kept first,
        // because a value with no Change is harmless, and a Change that claims a value which
        // was never kept would mislead. A store that did not answer in time has failed, so
        // nothing is recorded, and its late answer is undone by the Credentials service.
        const storeCredential = (by: By, name: string, value: Redacted.Redacted) =>
          commit(by, () =>
            Effect.as(credentials.set(name, value), {
              _tag: "CredentialSet",
              name,
            } satisfies Change)
          );

        // A configured Network's host, which only a stopping Daemon lacks.
        const hostOf = Effect.fnUntraced(function* (id: NetworkId) {
          yield* requireNetwork(yield* SubscriptionRef.get(configuration), id);

          const host = (yield* Ref.get(hosts)).get(id);

          return host ?? (yield* new NotInSession({ phase: "closed" }));
        });

        const isIn = Effect.fnUntraced(function* (host: NetworkHost, channel: string) {
          const { joined, phase } = yield* host.status;
          const key = channelKey(channel);

          return phase === "session" && joined.some((name) => channelKey(name) === key);
        });

        const sendPart = Effect.fnUntraced(function* (
          host: NetworkHost,
          by: By,
          channel: string,
          reason?: string
        ) {
          return yield* sendThrough(host, yield* built(partLine(channel, reason)), by);
        });

        // A Channel no longer on a Network's list is left, if Self is in it (CONF-2). The
        // Change is already recorded, so a `PART` that cannot go now is not its failure, and
        // the next Session does not join it again anyway.
        const partDropped = (by: By, before: Configuration, after: Configuration) =>
          Effect.forEach(
            droppedChannels(before, after),
            ({ channels, id }) =>
              Effect.gen(function* () {
                const host = (yield* Ref.get(hosts)).get(id);

                if (host !== undefined) {
                  for (const channel of channels) {
                    if (yield* isIn(host, channel)) {
                      yield* Effect.ignore(sendPart(host, by, channel));
                    }
                  }
                }
              }),
            { discard: true }
          );

        const viewOf = Effect.fnUntraced(function* ({ settings }: ConfiguredNetwork) {
          const host = (yield* Ref.get(hosts)).get(settings.id);

          return {
            settings,
            status:
              host === undefined
                ? unhosted(settings)
                : toNetworkState(settings, yield* host.status),
          };
        });

        const toggled = (
          by: By,
          id: NetworkId,
          change: (id: NetworkId) => Extract<Change, { readonly id: NetworkId }>
        ) =>
          commit(by, (current) => Effect.as(requireNetwork(current, id), change(id))).pipe(
            Effect.map(({ sequence }) => ({ change: sequence }))
          );

        const stop = yield* Effect.cached(
          changing
            .withPermit(
              Ref.set(stopping, true).pipe(Effect.andThen(Scope.close(hostsScope, Exit.void)))
            )
            .pipe(
              Effect.andThen(record([{ _tag: "Daemon", phase: "stopped", version }], constVoid)),
              Effect.catchTag("RecordFailed", (failed) =>
                Effect.logError("The Daemon's stop could not be recorded", failed)
              )
            )
        );

        yield* Effect.addFinalizer(() => stop);

        return {
          addNetwork: Effect.fnUntraced(function* (by, settings) {
            const { sequence } = yield* commit(by, (current) =>
              current.networks.has(settings.id)
                ? Effect.fail(new NetworkExists({ network: settings.id }))
                : Effect.succeed<Change>({ _tag: "NetworkAdded", settings })
            );

            return { change: sequence };
          }),
          authorize: (presented) =>
            SubscriptionRef.get(configuration).pipe(
              Effect.flatMap(({ keys }) => findKey(keys, presented)),
              Effect.provideContext(keyContext)
            ),
          // Not a Change, so it takes no permit, and runs on a Worker of its own (RUN-2).
          backup: Effect.mapError(
            reader.backup,
            ({ cause }) => new BackupFailed({ reason: reasonOf(cause) })
          ),
          changeNetwork: Effect.fnUntraced(function* (by, id, settings) {
            if (settings.id !== id) {
              return yield* new InvalidRequest({
                issues: [
                  {
                    message: "must be the Network's ID, which cannot change",
                    path: ["payload", "id"],
                  },
                ],
              });
            }

            const { after, before, sequence } = yield* commit(by, (current) =>
              Effect.as(requireNetwork(current, id), {
                _tag: "NetworkChanged",
                settings,
              } satisfies Change)
            );

            yield* partDropped(by, before, after);

            return { change: sequence };
          }),
          configuration: Effect.map(SubscriptionRef.get(configuration), (current) => ({
            networks: byId(current).map(({ settings }) => settings),
          })),
          connect: (by, id) =>
            toggled(by, id, (network) => ({ _tag: "NetworkConnected", id: network })),
          createKey: Effect.fnUntraced(function* (by, { name, scope }) {
            const key = yield* Effect.provideContext(newKey, keyContext);
            const hash = yield* Effect.provideContext(hashKey(key), keyContext);

            const { sequence } = yield* commit(by, (current) =>
              current.keys.has(name)
                ? Effect.fail(new KeyExists({ keyName: name }))
                : Effect.succeed<Change>({ _tag: "KeyCreated", hash, name, scope })
            );

            return { change: sequence, key, name, scope };
          }),
          credentials: credentials.names.pipe(
            Effect.map((names) => ({ credentials: names, store: credentials.store }))
          ),
          deleteCredential: (by, name) =>
            commit(by, (current) =>
              Effect.gen(function* () {
                const deleted = yield* credentials.delete(name);

                if (!deleted && current.credentials.get(name)?.set !== true) {
                  return yield* new CredentialNotFound({ credential: name });
                }

                return { _tag: "CredentialDeleted", name } satisfies Change;
              })
            ).pipe(Effect.map(({ sequence }) => ({ change: sequence }))),
          disconnect: (by, id) =>
            toggled(by, id, (network) => ({ _tag: "NetworkDisconnected", id: network })),
          // Every read goes to the reader, so none can delay an append (LOG-11).
          entries: (query) => fromReader(reader.entries(query)),
          gaps: (query) => fromReader(reader.gaps(query)),
          join: Effect.fnUntraced(function* (by, id, { channel, key, remember }) {
            const network = yield* requireNetwork(yield* SubscriptionRef.get(configuration), id);
            // The name the Channel's key is kept under, or would be (CRED-4).
            const keyName = keyNameFor(network.settings, channel);

            if (remember) {
              // The key is a Credential first, recorded as one, and only then named by the
              // Channel, so that no Change names a key that was never kept (CRED-4).
              if (key !== undefined) {
                yield* storeCredential(by, keyName, key);
              }

              // The reconciler reads what is wanted on every plan, so it sends the `JOIN`,
              // and nothing here can send a second one.
              const { sequence } = yield* commit(by, (current) =>
                Effect.as(requireNetwork(current, id), {
                  _tag: "ChannelJoined",
                  channel: { name: channel, ...(key !== undefined && { key: keyName }) },
                  network: id,
                } satisfies Change)
              );

              return { change: sequence };
            }

            const host = yield* hostOf(id);

            // A key that is not to be remembered is built in as a Credential's would be, so
            // the Log has `<redacted>` in its place, under the name it would have (LOG-6).
            const [batch] = keyedJoins(
              [{ name: channel, ...(key !== undefined && { key: keyName }) }],
              key === undefined ? noSecrets : new Map([[keyName, key]])
            ).batches;

            if (batch === undefined) {
              return yield* new InvalidMessage({ reason: "InvalidTarget" });
            }

            // Nothing sends a duplicate `JOIN` (LOG-5).
            if (yield* isIn(host, channel)) {
              return { line: { reason: "AlreadyJoined", status: "skipped" } } as const;
            }

            return { line: yield* sendThrough(host, batch.line, by, joinSensitive(batch)) };
          }),
          keys: Effect.map(SubscriptionRef.get(configuration), ({ keys }) =>
            [...keys]
              .map(([name, { created, scope }]) => ({ created, name, scope }))
              .toSorted((one, other) => (one.name < other.name ? -1 : 1))
          ),
          messages: (query) => fromReader(reader.messages(query)),
          network: Effect.fnUntraced(function* (id) {
            return yield* viewOf(
              yield* requireNetwork(yield* SubscriptionRef.get(configuration), id)
            );
          }),
          networks: Effect.flatMap(SubscriptionRef.get(configuration), (current) =>
            Effect.forEach(byId(current), viewOf)
          ),
          part: Effect.fnUntraced(function* (
            by,
            id,
            { channel, reason }
          ): Effect.fn.Return<Parted, ChannelNotFound | NetworkNotFound | Recording | SendRefusal> {
            const network = yield* requireNetwork(yield* SubscriptionRef.get(configuration), id);
            const key = channelKey(channel);
            const host = (yield* Ref.get(hosts)).get(id);
            // The host, if Self is in the Channel now.
            const within = host !== undefined && (yield* isIn(host, channel)) ? host : undefined;

            const configured = network.settings.channels.some(
              ({ name }) => channelKey(name) === key
            );

            // Built first, so that a `PART` that cannot be sent refuses the Part whole.
            const line = yield* built(partLine(channel, reason));

            if (!configured) {
              return within === undefined
                ? yield* new ChannelNotFound({ channel, network: id })
                : { line: yield* sendThrough(within, line, by) };
            }

            // Recorded first, so that no reconciler joins it again after the `PART`.
            const { sequence } = yield* commit(by, (current) =>
              Effect.as(requireNetwork(current, id), {
                _tag: "ChannelParted",
                channel,
                network: id,
              } satisfies Change)
            );

            if (within === undefined) {
              return { change: sequence };
            }

            // The Change stands whatever becomes of the `PART`, so its failure is reported
            // beside it rather than in its place (API-9).
            const sent = yield* sendThrough(within, line, by).pipe(
              Effect.catch((error) => Effect.succeed({ error, status: "failed" as const }))
            );

            return { change: sequence, line: sent };
          }),
          redact: (by, sequence) =>
            commitWith(
              by,
              () => Effect.succeed({ _tag: "EntryRedacted", sequence } as const),
              (before, who, change) =>
                recordRedaction(log.redact, before, who, change).pipe(
                  Effect.catchTags({
                    EntryAlreadyRedacted: ({ change: taken }) =>
                      Effect.fail(new EntryAlreadyRedacted({ change: taken, sequence })),
                    EntryNotFound: () => Effect.fail(new EntryNotFound({ sequence })),
                    EntryNotRedactable: ({ kind }) =>
                      Effect.fail(new EntryNotRedactable({ kind, sequence })),
                    StorageFailed: () => Effect.fail(new LogUnavailable()),
                  })
                )
            ).pipe(Effect.map(({ sequence: change }) => ({ change }))),
          removeNetwork: (by, id) =>
            commit(by, (current) =>
              Effect.as(requireNetwork(current, id), {
                _tag: "NetworkRemoved",
                id,
              } satisfies Change)
            ).pipe(Effect.map(({ sequence }) => ({ change: sequence }))),
          replaceConfiguration: Effect.fnUntraced(function* (by, networks) {
            const { after, before, sequence } = yield* commit(by, () =>
              Effect.succeed<Change>({ _tag: "ConfigurationReplaced", networks })
            );

            yield* partDropped(by, before, after);

            return { change: sequence };
          }),
          revokeKey: (by, name) =>
            commit(by, (current) => {
              const revoked = current.keys.get(name);

              // Its name, scope, and SHA-256, as creating it recorded (AUTH-2).
              return revoked === undefined
                ? Effect.fail(new KeyNotFound({ keyName: name }))
                : Effect.succeed<Change>({
                    _tag: "KeyRevoked",
                    hash: revoked.hash,
                    name,
                    scope: revoked.scope,
                  });
            }).pipe(Effect.map(({ sequence }) => ({ change: sequence }))),
          send: Effect.fnUntraced(function* (by, { network, target, text }) {
            const host = yield* hostOf(network);

            return yield* sendThrough(host, yield* built(privmsg(target, text)), by);
          }),
          setCredential: (by, name, value) =>
            storeCredential(by, name, value).pipe(
              Effect.map(({ sequence }) => ({ change: sequence }))
            ),
          // It is how a Frontend hears of a fault in the Log, so a fault must not stop it.
          // `head` stays on the writer, where it costs one lookup in the primary key.
          status: Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(configuration);
            const networks = yield* Effect.forEach(byId(current), viewOf);
            const head = yield* Effect.orElseSucceed(log.head, () => null);

            return {
              apiVersion,
              credentials: { store: credentials.store },
              head,
              networks: networks.map(({ status }) => status),
              version,
            };
          }),
          stop,
        };
      })
    );

  /**
   * Makes the Networks the first thing to stop. Everything that serves a Frontend depends
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
 * @param config - Where the Log lives, and the Daemon's version.
 * @param transport - How to reach an Ircd, which a test can replace.
 * @param keyring - The system keyring to try for Credentials, which a test can replace.
 * @param writeTimeout - How long a Credential's write is waited for, which a test can shorten.
 * @returns The Daemon, holding the data directory for as long as it lives.
 */
export const DaemonCore = (
  config: DaemonConfig,
  transport: Layer.Layer<Transport> = Transport.layer,
  keyring: Keyring = Bun.secrets,
  writeTimeout?: Duration.Input
): Layer.Layer<
  Daemon,
  CredentialsUnreadable | DataDirectoryLocked | LogTooNew | StorageFailed | UndecodableChange
> =>
  Daemon.layer(config).pipe(
    // The reader and Credentials start once the Log holds the data directory, and stop
    // before it lets go.
    Layer.provide(
      Layer.mergeAll(
        LogReader.layer({ dataDir: config.dataDir }),
        Credentials.layer({
          dataDir: config.dataDir,
          keyring,
          ...(writeTimeout !== undefined && { writeTimeout }),
        })
      ).pipe(Layer.provideMerge(Log.layer({ dataDir: config.dataDir })))
    ),
    Layer.provide(transport),
    Layer.provide(keyCrypto)
  );
