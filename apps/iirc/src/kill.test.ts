import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";

import { BunServices } from "@effect/platform-bun";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import type { Gap, LogEntry } from "@iirc/api";
import { fold, phase } from "@iirc/lifecycle";
import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning } from "@iirc/lifecycle/tuning";
import { toEvent } from "@iirc/session/events";
import {
  consecutiveFailures,
  foldStandings,
  nextAttempt,
  noStanding,
  noStandings,
} from "@iirc/session/standing";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Random, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  appRoot,
  createKey,
  freePort,
  healthyClient,
  logTail,
  networkStatus,
  settingsFor,
  startBinary,
} from "./binary.ts";
import { assertBackoff, buildBinary, buildTimeout } from "./testing.ts";

// PROOF-4 against the real thing: the minified binary the release build makes, on a real
// socket, killed for real. Set
// IIRC_KILL_SEED to the seed a failure logged, and the same plan runs again.

const binary = `${appRoot}/dist/iirc`;
const seedVariable = "IIRC_KILL_SEED";

// Twenty-odd seconds alone, for the rounds it kills and restarts, and several times that on
// a busy machine, so this is far past it.
const testTimeout = 300_000;

const network = "kill";
const channel = "#kill";
const nick = "iirc";
const username = "user";
const realname = "Kill Test";

// A kill counts as a failed Connection, so the runs that follow one wait out a real delay,
// which doubles from 40 ms. The last run must hold still while it is read after its
// Connection ends, which needs a wait far longer than any read, and by then the doubling
// has reached the 2 seconds that gives. Tuning is Configuration, so one value serves every
// run: changing it between runs would itself ask for a retry (CONF-2).
//
// The Ircd hangs up the moment it has said `ERROR`, as Ircds do, so a Line the Daemon
// writes as that happens reaches a kernel and never the Ircd, which LOG-2 counts as
// written. The clean run has to end where the Daemon has nothing of its own left to send,
// so the lag check, which would send a `PING` whenever it fell due, waits longer than any
// run takes, and the silence it guards waits longer still (LIVE-3).
const killTuning = {
  lagCheckMillis: 3_600_000,
  reconnectInitialMillis: 40,
  reconnectMaxMillis: 2000,
  silenceMillis: 7_200_000,
};

const tuned = (overrides: Partial<Tuning>) => ({ ...defaultTuning, ...overrides });

const finalTuning = tuned(killTuning);

// How long a healthy run may take to do each thing, all far past what it needs.
const startLimit = "30 seconds";
const closeLimit = "30 seconds";

// A stop that hung on a Frontend would not end at all, so this only has to be past a stop
// on a busy machine, which alone takes well under a second.
const shutdownLimit = 8000;

// Each cycle is one `PING`, with up to this many `PRIVMSG`s around it. It is the only
// thing that limits the flood: nothing more goes out until the `PONG` comes back, so a
// `PING` is never buried in a backlog, and two are never in one transaction. Without
// that a kill could leave several unanswered, which LOG-4 allows and check 4 would not.
const maxLinesPerCycle = 48;
const cycleLengths = 64;
const hostileEvery = 7;
const padding = "x".repeat(40);

// Kills a run that is mid-flood, this many `PONG`s or this many milliseconds in.
const maxPongsBeforeKill = 150;
const maxFloodMillis = 600;
const maxRegisteringMillis = 3;

// `OnPong` rounds are what catch a record that trails its write, because they land
// inside that gap. The rest kill whatever else happens to be running.
const pongRounds = 6;
const floodRounds = 4;
const registeringRounds = 2;

const pageSize = 1000;

// How much of what each Connection sent to show when the count of them is wrong.
const wireBytesShown = 200;

const encoder = new TextEncoder();
const lineEnding = encoder.encode("\r\n");
const hostileBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);

/** Exactly what crossed one Connection, as the Ircd saw it. */
interface Wire {
  readonly closed: Deferred.Deferred<void>;
  // Where it falls among the Connections accepted, counting from 1.
  readonly id: number;
  readonly openedAt: number;
  readonly remoteAddress: string;
  // Every byte received, whether or not it ever made a Line.
  bytes: Uint8Array;
  // Every Line sent, in order, without its line ending.
  readonly sent: Uint8Array[];
  // Every Line received, in order, without its line ending.
  readonly received: string[];
  readonly pongs: string[];
  counter: number;
  cycles: number;
  // Bytes the kernel would not take yet.
  pending: Uint8Array;
  // A Line received in part, waiting for the rest.
  partial: string;
  pings: number;
  // Whether to hang up once `pending` is gone, as an Ircd does after `ERROR`.
  ending: boolean;
}

/** What the Ircd is waiting to see from the Daemon it was told to expect. */
interface Expected {
  readonly holdRegistration: boolean;
  // The Daemon has rejoined, which is the last thing it sends of its own accord.
  readonly joined: Deferred.Deferred<void>;
  readonly registered: Deferred.Deferred<void>;
  readonly traffic: Deferred.Deferred<void>;
}

type KillPlan =
  | { readonly _tag: "Registering"; readonly millis: number }
  | { readonly _tag: "OnPong"; readonly pongs: number }
  | { readonly _tag: "Flood"; readonly millis: number };

const concat = (parts: readonly Uint8Array[]) => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }

  return whole;
};

const bytesEqual = (one: Uint8Array, other: Uint8Array) => Buffer.compare(one, other) === 0;

// Straight to the pipe, because vitest hides what a passing test prints, and a seed is
// no use unless it can be read after any run, even one that hangs.
const report = (text: string) => {
  writeSync(process.stdout.fd, `${text}\n`);
};

const sigkill = (pid: number) => {
  process.kill(pid, "SIGKILL");
};

// Runs the Ircd's side of the test, and keeps its books. A `write` can take less than
// it was given, so the ledger is only honest if the rest really follows on `drain`.
// Every Connection counts from `open`, because a silent extra dial is a real bug, and
// the address is private to this run, so only what was told it can be connecting.
const scriptedIrcd = Effect.fnUntraced(function* (host: string, lengths: readonly number[]) {
  const wires: Wire[] = [];
  let expected: Expected | undefined;
  let finishing = false;
  let killAfterPongs: { readonly pid: number; pongs: number } | undefined;

  const flush = (socket: Bun.Socket<Wire>) => {
    const wire = socket.data;

    if (wire.pending.length > 0) {
      const taken = socket.write(wire.pending);

      wire.pending = wire.pending.subarray(Math.max(taken, 0));
    }

    if (wire.ending && wire.pending.length === 0) {
      socket.end();
    }
  };

  const send = (socket: Bun.Socket<Wire>, lines: readonly Uint8Array[]) => {
    const wire = socket.data;

    wire.sent.push(...lines);
    wire.pending = concat([wire.pending, ...lines.flatMap((line) => [line, lineEnding])]);
    flush(socket);
  };

  const message = (wire: Wire) => {
    wire.counter += 1;

    const text = encoder.encode(
      `:peer!u@host PRIVMSG ${channel} :c${wire.id} n${wire.counter} ${padding}`
    );

    return wire.counter % hostileEvery === 0 ? concat([text, hostileBytes]) : text;
  };

  const ping = (wire: Wire) => {
    wire.pings += 1;

    return encoder.encode(`PING :c${wire.id}-p${wire.pings}`);
  };

  const cycle = (socket: Bun.Socket<Wire>) => {
    const wire = socket.data;
    const lines = lengths[wire.cycles % lengths.length] ?? 0;
    const beforePing = (wire.cycles * 5) % (lines + 1);
    const messages = Array.from({ length: lines }, () => message(wire));

    wire.cycles += 1;
    send(socket, [...messages.slice(0, beforePing), ping(wire)]);

    // On its own, so it can land in a later read than the `PING`, which must then wait
    // for that `PONG` (check 4). The queue keeps it ahead of anything sent after it.
    setImmediate(() => {
      send(socket, messages.slice(beforePing));
    });
  };

  const onPong = (socket: Bun.Socket<Wire>, token: string) => {
    socket.data.pongs.push(token);

    if (expected !== undefined) {
      Deferred.doneUnsafe(expected.traffic, Exit.void);
    }

    if (killAfterPongs !== undefined) {
      killAfterPongs.pongs -= 1;

      // Here, with the Daemon no further on than the write that just landed.
      if (killAfterPongs.pongs <= 0) {
        sigkill(killAfterPongs.pid);
        killAfterPongs = undefined;

        return;
      }
    }

    if (finishing) {
      setImmediate(() => {
        socket.data.ending = true;
        send(socket, [encoder.encode("ERROR :end of the test")]);
      });
    } else {
      cycle(socket);
    }
  };

  const onLine = (socket: Bun.Socket<Wire>, line: string) => {
    socket.data.received.push(line);

    if (line.startsWith("USER ") && expected !== undefined) {
      Deferred.doneUnsafe(expected.registered, Exit.void);

      if (!expected.holdRegistration) {
        send(socket, [
          encoder.encode(`:ircd 001 ${nick} :Welcome c${socket.data.id}`),
          encoder.encode(`:ircd 422 ${nick} :No MOTD`),
        ]);
        cycle(socket);
      }
    }

    if (line.startsWith("JOIN ")) {
      send(socket, [encoder.encode(`:${nick}!~u@host ${line}`)]);

      if (expected !== undefined) {
        Deferred.doneUnsafe(expected.joined, Exit.void);
      }
    }

    if (line.startsWith("PONG ")) {
      onPong(socket, line.slice("PONG ".length).replace(/^:/u, ""));
    }
  };

  const listener = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.listen<Wire>({
        hostname: host,
        port: 0,
        socket: {
          close: (socket) => {
            Deferred.doneUnsafe(socket.data.closed, Exit.void);
          },
          data: (socket, chunk) => {
            socket.data.bytes = concat([socket.data.bytes, chunk]);

            const lines = `${socket.data.partial}${chunk.toString("latin1")}`.split("\r\n");

            socket.data.partial = lines.pop() ?? "";

            for (const line of lines) {
              onLine(socket, line);
            }
          },
          drain: flush,
          // A killed peer resets the Connection, which is what this whole test is.
          error: () => {},
          open: (socket) => {
            socket.data = {
              bytes: new Uint8Array(),
              closed: Deferred.makeUnsafe(),
              counter: 0,
              cycles: 0,
              ending: false,
              id: wires.length + 1,
              openedAt: Date.now(),
              partial: "",
              pending: new Uint8Array(),
              pings: 0,
              pongs: [],
              received: [],
              remoteAddress: socket.remoteAddress,
              sent: [],
            };

            wires.push(socket.data);
          },
        },
      })
    ),
    (listening) =>
      Effect.sync(() => {
        listening.stop(true);
      })
  );

  return {
    // Kills `pid` the instant the Ircd has seen `pongs` more `PONG`s.
    armKill: (pid: number, pongs: number) => {
      killAfterPongs = { pid, pongs };
    },
    // Tells the Ircd which Daemon comes next, returning what will mark its progress.
    expect: (options: { readonly holdRegistration: boolean }) => {
      const next: Expected = {
        ...options,
        joined: Deferred.makeUnsafe(),
        registered: Deferred.makeUnsafe(),
        traffic: Deferred.makeUnsafe(),
      };

      expected = next;

      return next;
    },
    // Tells the Ircd to stop the flood, and to say `ERROR` after the next `PONG`.
    finish: () => {
      finishing = true;
    },
    host,
    port: listener.port,
    wires,
  };
});

type Ircd = Effect.Success<ReturnType<typeof scriptedIrcd>>;

// All of them, because an extra dial that speaks IRC looks just like one of ours, and
// any of them could turn out to be the odd one once this is read beside the Log.
const describeWires = (wires: readonly Wire[]) =>
  wires
    .map(
      ({ bytes, id, openedAt, remoteAddress }) =>
        `Connection ${id}: opened ${new Date(openedAt).toISOString()} from ${remoteAddress}, ${bytes.length} bytes received: ${JSON.stringify(Buffer.from(bytes.subarray(0, wireBytesShown)).toString("latin1"))}`
    )
    .join("\n");

// Checked as each run ends and not only at the end, because a stray Connection throws
// off everything that follows, and what it looked like is the evidence worth having.
const assertConnections = (wires: readonly Wire[], expected: number, why: string) => {
  assert.strictEqual(wires.length, expected, `${why}\n${describeWires(wires)}`);
};

// CONF-4: a data directory and a listen address, and nothing else.
const daemonArguments = (httpPort: number, extra: readonly string[] = []) => [
  "daemon",
  "--http-port",
  String(httpPort),
  ...extra,
];

// What the flags used to say, as settings, which the first run adds through the API.
const killNetwork = (ircd: { readonly host: string; readonly port: number }) =>
  settingsFor({
    channels: [channel],
    host: ircd.host,
    id: network,
    nick,
    port: ircd.port,
    realname,
    tuning: killTuning,
    username,
  });

const startKillable = (flags: readonly string[], environment: Readonly<Record<string, string>>) =>
  startBinary(binary, flags, environment);

type Running = Effect.Success<ReturnType<typeof startKillable>>;

// Waits on something only a living Daemon can do, and says what went wrong if it died.
const awaitDaemon = (running: Running, what: string, event: Deferred.Deferred<void>) =>
  Effect.raceFirst(
    Deferred.await(event),
    Effect.flatMap(Effect.ignore(running.child.exitCode), () =>
      Effect.die(new Error(`The Daemon exited before ${what}:\n${running.output()}`))
    )
  ).pipe(
    Effect.timeoutOrElse({
      duration: startLimit,
      orElse: () => Effect.die(new Error(`Timed out before ${what}:\n${running.output()}`)),
    })
  );

// The newest Connection has closed, and the Ircd has read all it ever will from it.
const lastWireClosed = ({ wires }: Ircd) =>
  Effect.forEach(wires.slice(-1), ({ closed }) => Deferred.await(closed), { discard: true }).pipe(
    Effect.timeoutOrElse({
      duration: closeLimit,
      orElse: () =>
        Effect.die(new Error(`The Ircd's Connection never closed\n${describeWires(wires)}`)),
    })
  );

const killedAndGone = (ircd: Ircd, running: Running) =>
  Effect.gen(function* () {
    yield* Effect.ignore(running.child.exitCode).pipe(
      Effect.timeoutOrElse({
        duration: startLimit,
        orElse: () => Effect.die(new Error(`The kill never came:\n${running.output()}`)),
      })
    );
    yield* Fiber.join(running.reader);
    yield* lastWireClosed(ircd);
  });

const killRound = (
  ircd: Ircd,
  plan: KillPlan,
  httpPort: number,
  dataDir: string,
  // Only the first run has a Network to add. Every later one finds it in the Log.
  configureWith: string | undefined
) =>
  Effect.gen(function* () {
    const progress = ircd.expect({ holdRegistration: plan._tag === "Registering" });

    // Not `--data-dir`, which the second process below covers.
    const running = yield* startKillable(daemonArguments(httpPort), { IIRC_DATA_DIR: dataDir });

    const { pid } = running.child;

    if (configureWith !== undefined) {
      const client = yield* healthyClient(httpPort, configureWith);

      yield* client.networks.add({ payload: killNetwork(ircd) });
    }

    yield* awaitDaemon(running, "registering", progress.registered);

    if (plan._tag !== "Registering") {
      yield* awaitDaemon(running, "any traffic", progress.traffic);
    }

    switch (plan._tag) {
      case "OnPong": {
        ircd.armKill(pid, plan.pongs);
        break;
      }

      case "Flood":
      case "Registering": {
        yield* Effect.sleep(`${plan.millis} millis`);
        sigkill(pid);
        break;
      }

      default: {
        plan satisfies never;
      }
    }

    yield* killedAndGone(ircd, running);
  }).pipe(Effect.scoped);

// RUN-4, while a Daemon really is running on this data directory. It gets its own API
// port, so that the only thing left to refuse it is the lock.
const refusedSecondProcess = (ircd: Ircd, dataDir: string) =>
  Effect.gen(function* () {
    const httpPort = yield* freePort;
    const connections = ircd.wires.length;

    const second = yield* startKillable(daemonArguments(httpPort, ["--data-dir", dataDir]), {});

    const code = yield* second.child.exitCode.pipe(
      Effect.timeoutOrElse({
        duration: startLimit,
        orElse: () => Effect.die(new Error("A second process is running on one Log")),
      })
    );

    yield* Fiber.join(second.reader);

    assert.notStrictEqual(Number(code), 0, "a second process must not start");
    assert.include(second.output(), `The data directory ${dataDir} is locked by another process`);
    assertConnections(ircd.wires, connections, "a refused process must never reach the Ircd");
  }).pipe(Effect.scoped);

// Everything from the cursor on, a page at a time, after `already` if a read was begun.
const pagedFrom = <A extends { readonly sequence: number }, E>(
  read: (page: {
    readonly after: number;
    readonly limit: number;
  }) => Effect.Effect<readonly A[], E>,
  already: readonly A[] = []
) =>
  Effect.gen(function* () {
    const all: A[] = [...already];
    let page: readonly A[] = [];

    do {
      page = yield* read({ after: all.at(-1)?.sequence ?? 0, limit: pageSize });
      all.push(...page);
    } while (page.length === pageSize);

    return all;
  });

const isClosed = ({ phase: current }: { readonly phase: string }) => current === "closed";

const finalRun = (ircd: Ircd, runs: number, dataDir: string, key: string) =>
  Effect.gen(function* () {
    const httpPort = yield* freePort;
    const progress = ircd.expect({ holdRegistration: false });

    const running = yield* startKillable(daemonArguments(httpPort), { IIRC_DATA_DIR: dataDir });

    yield* awaitDaemon(running, "any traffic", progress.traffic);
    assertConnections(ircd.wires, runs, "the final run must dial once");
    yield* refusedSecondProcess(ircd, dataDir);

    const client = yield* healthyClient(httpPort, key);

    yield* client.daemon.send({
      payload: { network, target: channel, text: "sent through the API" },
    });

    // Nearly all of the Log is read while the Session is up. The Daemon dials again soon
    // after it ends, 1 to 2 seconds after, and a read of this size can take longer than
    // that on a busy machine, so only what the end of the Session added is read after it,
    // which is a few pages.
    const readEntries = (query: { readonly after: number; readonly limit: number }) =>
      client.daemon.entries({ query });

    const readMessages = (query: { readonly after: number; readonly limit: number }) =>
      client.daemon.messages({ query });

    const entriesBefore = yield* pagedFrom(readEntries);
    const messagesBefore = yield* pagedFrom(readMessages);

    // The rejoin waits a second after the burst, so it can still be to come, and a `JOIN`
    // written as the Ircd hangs up would be recorded and never received.
    yield* awaitDaemon(running, "rejoining", progress.joined);

    ircd.finish();

    yield* lastWireClosed(ircd);

    const status = yield* networkStatus(client, network).pipe(
      Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: isClosed })
    );

    const { head } = yield* client.daemon.status();

    const entries = yield* pagedFrom(readEntries, entriesBefore);
    const gaps = yield* pagedFrom((query) => client.daemon.gaps({ query }));
    const messages = yield* pagedFrom(readMessages, messagesBefore);

    // So that the restarts below, which only read, never dial the Ircd and add to them.
    yield* client.networks.disconnect({ params: { id: network } });

    const stopping = Date.now();

    yield* running.child.kill({ killSignal: "SIGTERM" });

    return {
      entries,
      exitCode: Number(yield* running.child.exitCode),
      gaps,
      head,
      messages,
      output: running.output(),
      shutdownMillis: Date.now() - stopping,
      status,
    };
  }).pipe(Effect.scoped);

type LineEntry = Extract<LogEntry, { readonly _tag: "Line" }>;

const lineEntries = (entries: readonly LogEntry[]) =>
  entries.filter((entry): entry is LineEntry => entry._tag === "Line");

const textOf = ({ bytes }: LineEntry) => Buffer.from(bytes).toString("latin1");

const tokenOf = (text: string, command: string) =>
  text.startsWith(`${command} `) ? text.slice(command.length + 1).replace(/^:/u, "") : undefined;

// Checks 2, 3, and 4 for one Connection. `clean` is the last, which nothing killed.
const assertConnection = (entries: readonly LineEntry[], wire: Wire, clean: boolean) => {
  const inbound = entries.filter((entry) => entry.direction === "inbound");
  const outbound = entries.filter((entry) => entry.direction === "outbound");
  const label = `Connection ${wire.id}`;

  // 2. What landed is a contiguous prefix of what was sent, with only a tail missing.
  assert.isAtMost(inbound.length, wire.sent.length, `${label}: more inbound than was sent`);

  for (const [index, entry] of inbound.entries()) {
    const sent = wire.sent[index] ?? new Uint8Array();

    if (!bytesEqual(entry.bytes, sent)) {
      assert.fail(`${label}: inbound Line ${index} is not the Line sent there`);
    }
  }

  if (clean) {
    assert.lengthOf(inbound, wire.sent.length, `${label}: a clean run lost a Line`);
  }

  // 3. Whatever reached the Ircd was recorded first, in wire order (LOG-4).
  assert.isAtMost(wire.received.length, outbound.length, `${label}: sent but not recorded`);

  for (const [index, text] of wire.received.entries()) {
    assert.strictEqual(outbound[index] && textOf(outbound[index]), text, `${label}: wire order`);
  }

  if (clean) {
    assert.lengthOf(wire.received, outbound.length, `${label}: recorded but never sent`);
  }

  const pings = inbound.flatMap((entry) => {
    const token = tokenOf(textOf(entry), "PING");

    return token === undefined ? [] : [{ entry, token }];
  });

  const pongs = new Map(
    outbound.flatMap((entry) => {
      const token = tokenOf(textOf(entry), "PONG");

      return token === undefined ? [] : [[token, entry] as const];
    })
  );

  for (const token of wire.pongs) {
    const pong = pongs.get(token);
    const ping = pings.find((candidate) => candidate.token === token);

    assert.isDefined(pong, `${label}: PONG ${token} reached the Ircd unrecorded`);
    assert.isDefined(ping, `${label}: PONG ${token} answers a PING never recorded`);
    assert.isBelow(ping?.entry.sequence ?? 0, pong?.sequence ?? 0, `${label}: PONG before PING`);
    assert.strictEqual(pong?.cause, "ping-reply");
  }

  // 4. Only the last `PING` can be unanswered, and only because the kill came between
  // its commit and its `PONG`. A later read would have waited for that `PONG`, so every
  // inbound Line after it must share its commit, and one commit is one `at`.
  const unanswered = pings.filter(({ token }) => !pongs.has(token));

  if (clean) {
    assert.deepStrictEqual(unanswered, [], `${label}: a clean run left a PING unanswered`);
  }

  assert.isAtMost(unanswered.length, 1, `${label}: more than the last PING is unanswered`);

  const [last] = unanswered;

  if (last !== undefined) {
    assert.strictEqual(last, pings.at(-1), `${label}: an answered PING follows an unanswered one`);

    for (const later of inbound.filter(({ sequence }) => sequence > last.entry.sequence)) {
      assert.strictEqual(later.at, last.entry.at, `${label}: a read overtook an unanswered PING`);
    }
  }
};

// 8. One Gap per Session, each ended by the next Session's `001`, and only the last open.
const assertGaps = (entries: readonly LogEntry[], gaps: readonly Gap[]) => {
  const welcomes = lineEntries(entries).filter(
    (line) => line.direction === "inbound" && textOf(line).startsWith(":ircd 001 ")
  );

  assert.lengthOf(gaps, welcomes.length, "every Session that ended must leave a Gap");
  assert.deepStrictEqual(
    gaps.slice(0, -1).map(({ ended }) => ended?.sequence),
    welcomes.slice(1).map(({ sequence }) => sequence),
    "each Gap is ended by the `001` of the next Session"
  );
  assert.isTrue(
    gaps.slice(0, -1).every(({ reason }) => reason === "the Daemon was killed"),
    "a kill leaves nothing but a killed Session behind it"
  );
  assert.deepInclude(gaps.at(-1), { network, reason: "end of the test" });
  assert.notProperty(gaps.at(-1), "ended");
};

const assertLog = (entries: readonly LogEntry[], wires: readonly Wire[], runs: number) => {
  // 1. Sequences are gapless from 1.
  assert.deepStrictEqual(
    entries.map(({ sequence }) => sequence),
    Array.from({ length: entries.length }, (_, index) => index + 1)
  );

  // Every run reached the Ircd before it was killed, so runs and Connections pair up.
  const attempts = entries.flatMap((entry) =>
    entry._tag === "Connection" && entry.phase === "attempt" ? [entry.sequence] : []
  );

  assert.lengthOf(
    entries.filter(({ _tag }) => _tag === "Daemon"),
    runs,
    "one `started` Entry per run, and none from the refused process"
  );
  assert.lengthOf(attempts, runs);
  assertConnections(wires, attempts.length, "the Ircd must see one Connection per `attempt`");

  const lines = lineEntries(entries);

  for (const [index, connection] of attempts.entries()) {
    const wire = wires[index];

    if (wire === undefined) {
      assert.fail(`no Ircd Connection for run ${index}`);
    }

    assertConnection(
      lines.filter((line) => line.connection === connection),
      wire,
      index === attempts.length - 1
    );
  }
};

const derivedTables = ["messages", "gaps"];

// Damages the derived tables with no Daemon running, and reports what is left of them.
const vandalise = (dataDir: string, damage: (table: string) => string) =>
  Effect.sync(() => {
    const database = new Database(`${dataDir}/iirc.sqlite`);

    const left = derivedTables.map((table) => {
      database.run(damage(table));

      const tables = database.query(`SELECT name FROM sqlite_master WHERE name = '${table}'`).all();
      const rows = tables.length === 0 ? [] : database.query(`SELECT * FROM ${table}`).all();

      return { rows: rows.length, tables: tables.length };
    });

    database.close();

    return left;
  });

// A real restart, then `/messages` and `/gaps`. The Network is disconnected by now, so
// nothing new can be said, and whatever it serves can only have come from Entries.
const derivedAfterRestart = (dataDir: string, key: string) =>
  Effect.gen(function* () {
    const httpPort = yield* freePort;

    const running = yield* startKillable(daemonArguments(httpPort), { IIRC_DATA_DIR: dataDir });

    const { daemon } = yield* healthyClient(httpPort, key);
    const gaps = yield* pagedFrom((query) => daemon.gaps({ query }));
    const messages = yield* pagedFrom((query) => daemon.messages({ query }));

    yield* running.child.kill({ killSignal: "SIGTERM" });

    return { gaps, messages };
  }).pipe(Effect.scoped);

const makePlans = Effect.gen(function* () {
  const flood = Effect.map(Random.nextIntBetween(0, maxFloodMillis), (millis): KillPlan => ({
    _tag: "Flood",
    millis,
  }));

  const onPong = Effect.map(Random.nextIntBetween(1, maxPongsBeforeKill), (pongs): KillPlan => ({
    _tag: "OnPong",
    pongs,
  }));

  const registering = Effect.map(
    Random.nextIntBetween(0, maxRegisteringMillis),
    (millis): KillPlan => ({ _tag: "Registering", millis })
  );

  return yield* Random.shuffle(
    yield* Effect.all([
      ...Array.from({ length: registeringRounds }, () => registering),
      ...Array.from({ length: floodRounds }, () => flood),
      ...Array.from({ length: pongRounds }, () => onPong),
    ])
  );
});

// Any address in 127/8 but 127.0.0.1, which is where anything else on the machine is.
const loopbackAlias = Effect.map(
  Effect.all(Array.from({ length: 3 }, () => Random.nextIntBetween(1, 255))),
  (octets) => `127.${octets.join(".")}`
);

const chooseSeed = Random.nextIntBetween(1, 2 ** 31).pipe(
  Effect.map(String),
  Effect.map((seed) => process.env[seedVariable] ?? seed)
);

const layers = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

describe("the compiled binary", () => {
  beforeAll(async () => {
    await Effect.runPromise(buildBinary(binary));
  }, buildTimeout);

  it.live(
    "PROOF-4: loses nothing, whenever it is killed",
    () =>
      Effect.gen(function* () {
        const seed = yield* chooseSeed;

        report(`kill test seed: ${seedVariable}=${seed}`);

        const random = <A, E, R>(effect: Effect.Effect<A, E, R>) => Random.withSeed(effect, seed);

        const plans = yield* random(makePlans);

        const lengths = yield* random(
          Effect.all(
            Array.from({ length: cycleLengths }, () => Random.nextIntBetween(0, maxLinesPerCycle))
          )
        );

        const fileSystem = yield* FileSystem.FileSystem;

        // Not `/tmp`, because that is tmpfs here, where fsync means nothing.
        const dataDir = yield* fileSystem.makeTempDirectoryScoped({
          directory: "/var/tmp",
          prefix: "iirc-kill-",
        });

        // AUTH-4: the first key comes before any Daemon, and starts no run of its own.
        const key = yield* createKey(binary, dataDir);
        const ircdHost = yield* random(loopbackAlias);

        report(`Ircd on ${ircdHost}`);

        const ircd = yield* scriptedIrcd(ircdHost, lengths);
        const httpPort = yield* freePort;
        const started = Date.now();

        yield* Effect.forEach(
          plans,
          (plan, index) =>
            Effect.gen(function* () {
              yield* killRound(ircd, plan, httpPort, dataDir, index === 0 ? key : undefined);
              assertConnections(ircd.wires, index + 1, `round ${index + 1} must dial once`);

              const wire = ircd.wires.at(-1);

              report(
                `round ${index + 1}: ${JSON.stringify(plan)}, sent ${wire?.sent.length} Lines, ` +
                  `${wire?.pongs.length} PONGs, at ${Date.now() - started} ms`
              );
            }),
          { discard: true }
        );

        const { entries, exitCode, gaps, head, messages, output, shutdownMillis, status } =
          yield* finalRun(ircd, plans.length + 1, dataDir, key);

        report(
          `final run: ${entries.length} Entries, ${messages.length} Messages, ` +
            `${gaps.length} Gaps, stopped in ${shutdownMillis} ms, at ${Date.now() - started} ms`
        );
        report(`Connections: ${ircd.wires.length} from ${plans.length + 1} runs`);

        assertLog(entries, ircd.wires, plans.length + 1);
        // 7. Every run but the first follows a kill, so its `attempt` must wait.
        assertBackoff(entries, () => finalTuning);
        assertGaps(entries, gaps);
        assert.notInclude(output, "ERROR", "HOST-1: nothing here should reach the error log");
        assert.isBelow(shutdownMillis, shutdownLimit, "stopping must not hang on a Frontend");
        assert.strictEqual(exitCode, 0, "SIGTERM is a clean stop");
        assert.deepStrictEqual(yield* logTail(dataDir, 1), ["Daemon stopped"]);

        // 6. Status is a fold, and nothing else: between Connections it is `Standing`'s,
        // and the machine agrees on the phase. Each `attempt` brings the Tuning its round
        // ran with, so the input here only stands before the first. `Standing` reads take
        // today's Tuning, because backoff is policy and not a record.
        const folded = fold(
          entries
            .filter((entry) => "network" in entry && entry.network === network)
            .flatMap((entry) => toEvent(entry) ?? []),
          { loginLines: 0, realname, services: [], tuning: finalTuning, username }
        );

        const standing = foldStandings(noStandings, entries).get(network) ?? noStanding;

        assert.deepInclude(status, {
          closeReason: standing.recent.at(-1)?.reason ?? null,
          consecutiveFailures: consecutiveFailures(standing, finalTuning, Date.now()),
          id: network,
          joined: [],
          nextAttemptAt: nextAttempt(standing, {
            ircds: [{ host: ircdHost, port: ircd.port, tls: false }],
            tuning: finalTuning,
          }).at,
          phase: phase(folded),
          self: null,
        });
        assert.strictEqual(status.phase, "closed");
        assert.strictEqual(status.closeReason, "end of the test");
        assert.strictEqual(head, entries.at(-1)?.sequence ?? 0);

        // 5. LOG-10: what is derived is disposable, and a restart is all it takes to get it
        // back. Last, because these restarts add Entries of their own.
        assert.isNotEmpty(messages);
        assert.isNotEmpty(gaps);

        assert.deepStrictEqual(yield* vandalise(dataDir, (table) => `DELETE FROM ${table}`), [
          { rows: 0, tables: 1 },
          { rows: 0, tables: 1 },
        ]);
        assert.deepStrictEqual(yield* derivedAfterRestart(dataDir, key), { gaps, messages });

        assert.deepStrictEqual(yield* vandalise(dataDir, (table) => `DROP TABLE ${table}`), [
          { rows: 0, tables: 0 },
          { rows: 0, tables: 0 },
        ]);
        assert.deepStrictEqual(yield* derivedAfterRestart(dataDir, key), { gaps, messages });
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: testTimeout }
  );
});
