import type { NetworkInput } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import { outbound } from "@iirc/protocol/outbound";
import { Array as Arr, Effect, Layer, pipe, SubscriptionRef } from "effect";
import { identity } from "effect/Function";

import type { Entry, Ircd, NetworkId, NewEntry } from "./entry.ts";
import { constantNetwork, hostNetwork } from "./network.ts";
import type { NetworkSettings, NetworkStatus } from "./network.ts";
import { MemoryEntries, Recorder, RecordFailed } from "./recorder.ts";
import { movingClockWhileClosing } from "./testing.ts";
import type { FakeIrcd } from "./testing.ts";
import { Transport } from "./transport.ts";

/** An Entry holding a Line. */
export type LineEntry = Extract<Entry, { readonly _tag: "Line" }>;

/** An Entry about a Connection. */
export type ConnectionEntry = Extract<Entry, { readonly _tag: "Connection" }>;

/** The Ircd tests connect to, which only a fake ever answers for. */
export const address: Ircd = { host: "irc.test", port: 6697, tls: true };

/** What the machine starts from under {@link options}. */
export const input: NetworkInput = {
  loginLines: 0,
  realname: "I IRC",
  services: [],
  tuning: defaultTuning,
  username: "user",
};

/** A Network, and what a test may change about how it is hosted. */
export type Overrides = Partial<NetworkSettings> & { readonly id?: NetworkId };

/** A Network with two Channels to be in. */
export const options: NetworkSettings & { readonly id: NetworkId } = {
  channels: [{ name: "#one" }, { name: "#two" }],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: "libera",
  identity: { alternates: [], nick: "iirc", realname: "I IRC", username: "user" },
  ircds: [address],
  quitReason: "leaving",
  secrets: new Map(),
  services: [],
  tuning: defaultTuning,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes text.
 * @param text - The text.
 * @returns Its bytes.
 */
export const encode = (text: string) => encoder.encode(text);

/**
 * Decodes bytes.
 * @param bytes - The bytes.
 * @returns Their text.
 */
export const decode = (bytes: Uint8Array) => decoder.decode(bytes);

/** Everything recorded so far. */
export const entries = MemoryEntries.use(({ entries }) => entries);

/**
 * Picks out the Lines.
 * @param log - The Entries.
 * @returns The Line Entries.
 */
export const linesOf = (log: readonly Entry[]) =>
  log.filter((entry): entry is LineEntry => entry._tag === "Line");

/**
 * Picks out the Connection Entries of one phase.
 * @param log - The Entries.
 * @param phase - The phase.
 * @returns Those Entries.
 */
export const connectionsOf = <Phase extends ConnectionEntry["phase"]>(
  log: readonly Entry[],
  phase: Phase
) =>
  log.filter(
    (entry): entry is Extract<ConnectionEntry, { readonly phase: Phase }> =>
      entry._tag === "Connection" && entry.phase === phase
  );

/**
 * Reads the Lines that went one way.
 * @param log - The Entries.
 * @param direction - Which way.
 * @returns Each Line's text.
 */
export const texts = (log: readonly Entry[], direction: LineEntry["direction"]) =>
  linesOf(log)
    .filter((line) => line.direction === direction)
    .map(({ bytes }) => decode(bytes));

/**
 * Reads what reached a fake Ircd.
 * @param ircd - The Ircd.
 * @returns Each write's text.
 */
export const wire = (ircd: FakeIrcd) =>
  ircd.written.pipe(Effect.map((written) => written.map((bytes) => decode(bytes))));

/**
 * Runs a thousand scheduler turns without moving the clock. Every fake socket and the
 * memory Recorder answer within a few of them, so this is far more than they need, and
 * nothing real is awaited in them, so how busy the machine is cannot make it too few.
 * It does not know that the host has nothing left to do, however: a test that needs a
 * particular outcome awaits that outcome, an Entry or a status, and does not rely on this.
 */
export const manyTurns = Effect.repeat(Effect.yieldNow, { times: 1000 });

/** Runs a few scheduler turns, to hold something up without moving the clock. */
export const held = Effect.repeat(Effect.yieldNow, { times: 20 });

/**
 * Builds a Line a test knows to be fine.
 * @param command - Its command.
 * @param params - Its parameters.
 * @returns The Line.
 */
export const safe = (command: string, params: readonly string[]) => {
  const built = outbound(command, params);

  if (built._tag === "Rejected") {
    throw new Error(built.reason);
  }

  return built.line;
};

/**
 * Starts a host whose Scope the test closes itself, moving the clock as it needs to.
 * @param ircd - Where it connects.
 * @param overrides - What differs from {@link options}.
 * @returns The host, after {@link manyTurns}.
 */
export const bareHost = (ircd: Pick<FakeIrcd, "transport">, overrides?: Overrides) => {
  const { id, ...settings } = { ...options, ...overrides };

  return hostNetwork(constantNetwork(id, settings)).pipe(
    Effect.provideService(Transport, ircd.transport),
    Effect.tap(() => manyTurns)
  );
};

/**
 * Starts a host that can be left running when a test ends.
 * @param ircd - Where it connects.
 * @param overrides - What differs from {@link options}.
 * @returns The host, after {@link manyTurns}.
 */
export const host = (ircd: Pick<FakeIrcd, "transport">, overrides?: Overrides) =>
  movingClockWhileClosing(bareHost(ircd, overrides));

/**
 * Starts a host whose settings a test can change while it runs, as Configuration would.
 * @param ircd - Where it connects.
 * @param overrides - What differs from {@link options} to begin with.
 * @returns The host, and a way to change its settings that lets it settle after.
 */
export const liveHost = Effect.fnUntraced(function* (
  ircd: Pick<FakeIrcd, "transport">,
  overrides?: Overrides
) {
  const { id, ...initial } = { ...options, ...overrides };
  const current = yield* SubscriptionRef.make<NetworkSettings>(initial);

  const hosted = yield* movingClockWhileClosing(
    hostNetwork({
      changes: SubscriptionRef.changes(current),
      id,
      settings: SubscriptionRef.get(current),
    }).pipe(
      Effect.provideService(Transport, ircd.transport),
      Effect.tap(() => manyTurns)
    )
  );

  const change = (update: (settings: NetworkSettings) => NetworkSettings) =>
    Effect.andThen(SubscriptionRef.update(current, update), manyTurns);

  return { change, hosted };
});

/**
 * Starts a host and brings it to a Session.
 * @param ircd - Where it connects.
 * @returns The host.
 */
export const inSession = Effect.fnUntraced(function* (ircd: FakeIrcd) {
  const hosted = yield* host(ircd);

  yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
  yield* manyTurns;

  return hosted;
});

/** What a test wants to watch or break in a Recorder. */
export interface RecorderProbe {
  readonly after?: () => void;
  readonly afterWithin?: () => void;
  /** Runs between `within` and a COMMIT that `failsAfterWithin` is about to fail. */
  readonly beforeFailing?: Effect.Effect<void>;
  readonly before?: (entries: readonly NewEntry[]) => void;
  readonly failsAfterWithin?: (entries: readonly NewEntry[]) => boolean;
  readonly duringRecord?: (entries: readonly NewEntry[]) => Effect.Effect<void>;
  /** Watches `standing`. Throwing kills it. */
  readonly onStanding?: () => void;
  /** Changes what `within` is shown, without changing what is recorded. */
  readonly rewrite?: (entry: Entry) => Entry;
}

/**
 * Wraps the shared store, so a test can watch or break what `record` does. `within` runs
 * and only then does the wrapper fail, because that is what a failed COMMIT does.
 * @param probe - What to watch or break.
 * @returns A Recorder, with {@link MemoryEntries} to read back what it kept.
 */
export const probed = (probe: RecorderProbe) =>
  Layer.effect(
    Recorder,
    Recorder.pipe(
      Effect.map((recorder) =>
        Recorder.of({
          record: (entries, within) =>
            Effect.gen(function* () {
              probe.before?.(entries);
              yield* probe.duringRecord?.(entries) ?? Effect.void;

              if (probe.failsAfterWithin?.(entries) === true) {
                within(
                  pipe(
                    entries,
                    Arr.map((entry, index): Entry => ({ ...entry, at: 0, sequence: index }))
                  )
                );

                yield* probe.beforeFailing ?? Effect.void;

                return yield* new RecordFailed({ cause: "commit failed" });
              }

              const result = yield* recorder.record(entries, (recorded) => {
                const stepped = within(pipe(recorded, Arr.map(probe.rewrite ?? identity)));

                probe.afterWithin?.();

                return stepped;
              });

              probe.after?.();

              return result;
            }),
          standing: (network) =>
            Effect.suspend(() => {
              probe.onStanding?.();

              return recorder.standing(network);
            }),
        })
      )
    )
  ).pipe(Layer.provideMerge(Recorder.memoryReadable));

// The machine reads this as it enters a Session, and the host never does.
/** Tuning that makes a real transition throw, with no test-only path through the host. */
export const throwing = Object.defineProperty({ ...defaultTuning }, "burstMillis", {
  enumerable: false,
  get: () => {
    throw new Error("the transition threw");
  },
});

/**
 * Keeps what a fold of the Log can also say.
 * @param status - A host's status.
 * @returns Its reason and Phase.
 */
export const brief = ({ closeReason, phase }: NetworkStatus) => ({ closeReason, phase });

/**
 * Picks out the Deadline Entries of one name.
 * @param log - The Entries.
 * @param name - The name.
 * @returns Those Entries.
 */
export const deadlinesNamed = (log: readonly Entry[], name: string) =>
  log.filter((entry) => entry._tag === "Deadline" && entry.name === name);

/**
 * Picks out the Dropped Entries.
 * @param log - The Entries.
 * @returns Those Entries.
 */
export const droppedIn = (log: readonly Entry[]) =>
  log.flatMap((entry) => (entry._tag === "Dropped" ? [entry] : []));

/**
 * Says whether an Entry closes a Connection.
 * @param entry - The Entry.
 * @returns Whether it does.
 */
export const isClosed = (entry: NewEntry) =>
  entry._tag === "Connection" && entry.phase === "closed";

/**
 * Makes a test for one Line.
 * @param text - The Line's text.
 * @returns Whether an Entry is that Line.
 */
export const isLineWith = (text: string) => (entry: NewEntry) =>
  entry._tag === "Line" && decode(entry.bytes) === text;
