/**
 * Property tests: random and hostile inputs, in whatever state they find the Client.
 * Each run folds a sequence of moves from `initial`, choosing Lines from a pool that
 * reaches every machine, mangling them, and firing the timers the Client set, and checks
 * the invariants after every step.
 */
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import { encode, isRejected, CredentialName } from "@iirc/protocol/line";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Step } from "../client.ts";
import { client } from "../core.ts";
import { ConnectionId, Instant, IntentId, TimerId } from "../ids.ts";
import type { Action, Input, Lookup, UnsentLine } from "../input.ts";
import { listedMembers } from "../members.ts";
import type { News } from "../news.ts";
import { timers } from "../output.ts";
import type { TimerTable } from "../output.ts";
import { maxLookups } from "../state.ts";
import type { State } from "../state.ts";
import { configured, epoch, impurity, snapshot } from "../testing/index.ts";
import { openOf } from "../views.ts";

const configurations = [
  configured(),
  configured({ channels: [{ name: "#iirc" }, { key: CredentialName.make("k"), name: "#secret" }] }),
  configured({
    channels: [{ name: "#Dev[Ops]" }],
    ircds: [
      { host: "a.test", port: 6697, tls: true },
      { host: "b.test", port: 6667, tls: false },
    ],
    nicks: ["one", "two"],
    password: CredentialName.make("pass"),
  }),
  configured({ enabled: false }),
  configured({ highlights: ["text", "Peer"] }),
];

const nicks = ["iirc", "iirc_", "peer", "Peer", "op", "[x]", "{x}", ""];
const channels = ["#iirc", "#IIRC", "#secret", "#dev{ops}", "#Dev[Ops]", "&local", "#other", ""];

// Lines that reach every machine, with parameters drawn from small pools so they meet
// the state they find: registration, caps, ISUPPORT, Channels, Messages, and the keepalive.
const line = fc.oneof(
  fc.constantFrom(
    ":irc.test 001 iirc :Welcome iirc!~iirc@host",
    ":irc.test 001",
    ":irc.test 421 * CAP :Unknown command",
    ":irc.test CAP * LS * :multi-prefix sasl=PLAIN",
    ":irc.test CAP * LS :away-notify",
    ":irc.test CAP iirc ACK :multi-prefix",
    ":irc.test CAP iirc NAK :multi-prefix",
    ":irc.test CAP iirc NEW :x y",
    ":irc.test CAP iirc DEL :multi-prefix",
    ":irc.test CAP",
    ":irc.test 005 iirc CASEMAPPING=ascii :are supported",
    ":irc.test 005 iirc CASEMAPPING=rfc1459 PREFIX=(qaohv)~&@%+ :are supported",
    ":irc.test 005 iirc -PREFIX -CASEMAPPING CHANTYPES=#& :are supported",
    ":irc.test 005 iirc PREFIX=(ov :are supported",
    ":irc.test 005 iirc TARGMAX=JOIN:1 CHANMODES=b,k,l,nt :x",
    "PING :token",
    "PING",
    ":irc.test PONG irc.test :iirc",
    "ERROR :Closing",
    ":irc.test 900 * * acct :logged in",
    ":irc.test 901 * * :out",
    ":irc.test 353 iirc = #iirc :iirc",
    ":irc.test 366 iirc #iirc :End",
    "AUTHENTICATE +",
    ""
  ),
  fc
    .tuple(
      fc.constantFrom(
        "433",
        "432",
        "436",
        "437",
        "471",
        "473",
        "474",
        "475",
        "403",
        "366",
        "331",
        "332",
        "333",
        "324"
      ),
      fc.constantFrom(...nicks),
      fc.constantFrom(...channels),
      fc.constantFrom("", "+ntk key", "op!u@h 1767225600", ":some text")
    )
    .map(([numeric, nick, channel, rest]) => `:irc.test ${numeric} ${nick} ${channel} ${rest}`),
  fc
    .tuple(
      fc.constantFrom(...nicks),
      fc.constantFrom(...channels),
      fc.constantFrom("", "@", "+", "@+", "~!", "%")
    )
    .map(
      ([nick, channel, prefix]) => `:irc.test 353 iirc = ${channel} :${prefix}${nick} iirc @peer +v`
    ),
  fc
    .tuple(
      fc.constantFrom(...nicks),
      fc.constantFrom(
        "JOIN",
        "PART",
        "QUIT",
        "NICK",
        "AWAY",
        "TOPIC",
        "MODE",
        "KICK",
        "PRIVMSG",
        "NOTICE"
      ),
      fc.constantFrom(...channels),
      fc.constantFrom(...nicks),
      fc.constantFrom(
        "",
        ":text",
        ":\u0001ACTION waves\u0001",
        ":hi iirc",
        ":\u0001ACTION pokes Peer\u0001",
        ":\u0001VERSION\u0001",
        "+o-v+k",
        "-k+l 5"
      )
    )
    .map(
      ([source, command, channel, target, rest]) =>
        `:${source}!~u@host ${command} ${channel} ${command === "KICK" ? target : ""} ${rest}`
    )
);

// A Lookup's reply, whole or mangled.
const replied = fc
  .tuple(
    fc.constantFrom("311", "312", "314", "317", "318", "319", "330", "369", "401", "406", "378"),
    fc.constantFrom(...nicks),
    fc.constantFrom("", "~u host * :Real", "5 1767225600 :idle", ":@#iirc +#other x", "acct :in")
  )
  .map(([numeric, nick, rest]) => `:irc.test ${numeric} iirc ${nick} ${rest}`);

const utf8 = new TextEncoder();

// Bytes a hostile Ircd might send: a pooled Line, mangled, or anything at all.
const bytes = fc.oneof(
  { arbitrary: line.map((text) => utf8.encode(text)), weight: 6 },
  {
    arbitrary: fc.tuple(line, fc.nat(), fc.uint8Array({ maxLength: 8 })).map(([text, at, junk]) => {
      const encoded = utf8.encode(text);
      const cut = at % (encoded.length + 1);

      return new Uint8Array([...encoded.subarray(0, cut), ...junk, ...encoded.subarray(cut)]);
    }),
    weight: 2,
  },
  { arbitrary: fc.uint8Array({ maxLength: 40 }), weight: 1 }
);

/** One move: what to do next, read against the state it meets. */
type Move =
  | { readonly _tag: "Configure"; readonly which: number }
  | { readonly _tag: "Started" }
  | { readonly _tag: "Retry" }
  | { readonly _tag: "Opened"; readonly stale: boolean }
  | { readonly _tag: "Received"; readonly bytes: Uint8Array; readonly stale: boolean }
  | { readonly _tag: "Closed"; readonly stale: boolean }
  | { readonly _tag: "Fire"; readonly which: number; readonly early: boolean }
  | { readonly _tag: "Wait"; readonly millis: number }
  | { readonly _tag: "Say"; readonly target: string; readonly text: string }
  | { readonly _tag: "Act"; readonly action: Action }
  | { readonly _tag: "Look"; readonly lookup: Lookup }
  | { readonly _tag: "Read"; readonly target: string | null; readonly read: number }
  | { readonly _tag: "Unfilled"; readonly line: number }
  | { readonly _tag: "Stopping" }
  | { readonly _tag: "Unsent"; readonly count: number; readonly stale: boolean };

const texts = fc.constantFrom("hi", "", "x".repeat(600), "a\r\nb", "two words");
const names = fc.constantFrom(...channels, ...nicks, "#a b", "a,b", "");

// The Owner's actions, well-formed and not.
const action: fc.Arbitrary<Action> = fc.oneof(
  fc.tuple(names, texts).map(([channel, text]) => ({ _tag: "Topic", channel, text }) as const),
  fc
    .tuple(names, fc.array(names, { maxLength: 4, minLength: 1 }), fc.option(texts))
    .map(
      ([channel, [first = "peer", ...rest], reason]) =>
        ({ _tag: "Kick", channel, nicks: [first, ...rest], reason }) as const
    ),
  fc
    .tuple(
      names,
      fc.array(
        fc.record({
          mode: fc.constantFrom("o", "v", "b", "k", "l", "m", "x", "+", ""),
          param: fc.option(fc.constantFrom("peer", "*!*@h", "5", ":x", "")),
          set: fc.boolean(),
        }),
        { maxLength: 8, minLength: 1 }
      )
    )
    .map(([target, [first, ...rest]]) =>
      first === undefined
        ? ({ _tag: "Away", message: null } as const)
        : ({ _tag: "Mode", changes: [first, ...rest], target } as const)
    ),
  fc.tuple(names, names).map(([nick, channel]) => ({ _tag: "Invite", channel, nick }) as const),
  names.map((nick) => ({ _tag: "Nick", nick }) as const),
  fc.option(texts).map((message) => ({ _tag: "Away", message }) as const),
  fc
    .constantFrom(
      "WHOIS peer",
      "CAP LS",
      ":me PING x",
      "PRIVMSG #iirc :hi",
      "",
      "@+a=b TAGMSG #iirc"
    )
    .map((line) => ({ _tag: "Raw", line }) as const)
);

// The moves of a running Network.
const running: fc.Arbitrary<Move> = fc.oneof(
  {
    arbitrary: fc
      .nat(configurations.length - 1)
      .map((which) => ({ _tag: "Configure", which }) as const),
    weight: 1,
  },
  { arbitrary: fc.constant({ _tag: "Started" } as const), weight: 1 },
  { arbitrary: fc.constant({ _tag: "Retry" } as const), weight: 1 },
  { arbitrary: fc.boolean().map((stale) => ({ _tag: "Opened", stale }) as const), weight: 2 },
  {
    arbitrary: fc
      .tuple(bytes, fc.boolean(), fc.boolean())
      .map(
        ([data, stale, other]) =>
          ({ _tag: "Received", bytes: data, stale: stale && other }) as const
      ),
    weight: 16,
  },
  { arbitrary: fc.boolean().map((stale) => ({ _tag: "Closed", stale }) as const), weight: 1 },
  {
    arbitrary: fc
      .tuple(fc.nat(), fc.boolean())
      .map(([which, early]) => ({ _tag: "Fire", early, which }) as const),
    weight: 3,
  },
  { arbitrary: fc.nat(120_000).map((millis) => ({ _tag: "Wait", millis }) as const), weight: 2 },
  {
    arbitrary: fc
      .tuple(
        fc.constantFrom(...channels, ...nicks, "#a b"),
        fc.constantFrom("hi", "", "x".repeat(600), "a\r\nb")
      )
      .map(([target, text]) => ({ _tag: "Say", target, text }) as const),
    weight: 2,
  },
  { arbitrary: fc.nat(2).map((which) => ({ _tag: "Unfilled", line: which }) as const), weight: 1 },
  { arbitrary: action.map((each) => ({ _tag: "Act", action: each }) as const), weight: 2 }
);

// And marking Timelines read, Lookups, and shutting down: a `Stopping` shuts the gate until the next `Started`, and Lines the
// Runtime dropped come back as `Unsent`. Each is rare, so a run still meets the rest.
const move: fc.Arbitrary<Move> = fc.oneof(
  { arbitrary: running, weight: 30 },
  {
    arbitrary: fc
      .tuple(fc.constantFrom(null, ...channels, ...nicks, "#a,#b"), fc.nat(200_000))
      .map(([target, read]) => ({ _tag: "Read", read, target }) as const),
    weight: 2,
  },
  { arbitrary: fc.constant({ _tag: "Stopping" } as const), weight: 1 },
  {
    arbitrary: fc
      .tuple(fc.boolean(), names)
      .map(
        ([whois, nick]) =>
          ({ _tag: "Look", lookup: { _tag: whois ? "Whois" : "Whowas", nick } }) as const
      ),
    weight: 2,
  },
  {
    arbitrary: replied.map(
      (text) => ({ _tag: "Received", bytes: utf8.encode(text), stale: false }) as const
    ),
    weight: 4,
  },
  {
    arbitrary: fc
      .tuple(fc.nat(4), fc.boolean())
      .map(([count, stale]) => ({ _tag: "Unsent", count, stale }) as const),
    weight: 1,
  }
);

const received = (text: string): Move => ({
  _tag: "Received",
  bytes: utf8.encode(text),
  stale: false,
});

// Where a run starts: from nothing, configured, open, registered, or in Channels, so
// random moves meet every machine.
const preludes: readonly (readonly Move[])[] = [
  [],
  [{ _tag: "Configure", which: 1 }],
  [
    { _tag: "Configure", which: 2 },
    { _tag: "Opened", stale: false },
  ],
  [
    { _tag: "Configure", which: 1 },
    { _tag: "Opened", stale: false },
    received(":irc.test CAP * LS :multi-prefix"),
    received(":irc.test 001 iirc :Welcome"),
    received(":irc.test 005 iirc CHANTYPES=# PREFIX=(ov)@+ :are supported"),
  ],
  [
    { _tag: "Configure", which: 1 },
    { _tag: "Opened", stale: false },
    received(":irc.test 421 * CAP :Unknown"),
    received(":irc.test 001 iirc :Welcome"),
    received(":iirc!~iirc@host JOIN #iirc"),
    received(":irc.test 353 iirc = #iirc :iirc @peer +v other"),
    received(":irc.test 366 iirc #iirc :End"),
    received(":iirc!~iirc@host JOIN #secret"),
  ],
];

const runOf = (moves: fc.Arbitrary<Move>) =>
  fc
    .tuple(fc.nat(preludes.length - 1), fc.array(moves, { maxLength: 150, minLength: 1 }))
    .map(([which, each]) => [...(preludes[which] ?? []), ...each]);

const run = runOf(move);

const reasons = ["Ended", "Reset", "Refused", "HungUp"] as const;

/** Where a run is. */
interface Fold {
  state: State;
  now: number;
  table: TimerTable;
  intents: number;
  /** The intents of `Look`s not yet reported. */
  readonly looking: Set<string>;
  /** Whether a `Stopping` has been stepped since the last `Started`. */
  stopping: boolean;
  readonly inputs: Input[];
  readonly steps: Step<State>[];
}

const secrets = [
  { _tag: "Pass", credential: CredentialName.make("pass") },
  { _tag: "JoinWithKey", channel: "#secret", credential: CredentialName.make("k") },
  { _tag: "AuthenticatePlain", authcid: "a", authzid: "a", credential: CredentialName.make("c") },
] as const;

// What the Owner says or does, under the next intent.
const owned = (
  fold: Fold,
  at: Instant,
  next: Extract<Move, { readonly _tag: "Say" | "Act" | "Look" }>
): Input => {
  fold.intents += 1;
  const intent = IntentId.make(`i${fold.intents}`);

  if (next._tag === "Look") {
    return { _tag: "Look", at, intent, lookup: next.lookup };
  }

  return next._tag === "Act"
    ? { _tag: "Act", action: next.action, at, intent }
    : { _tag: "Say", at, intent, kind: "Privmsg", target: next.target, text: next.text };
};

// A timer the table holds fires: one not early once it is due, as a clock fires it, and
// one early before its time.
const fire = (fold: Fold, next: Extract<Move, { readonly _tag: "Fire" }>): Input => {
  const set = [...fold.table];
  const at = Instant.make(fold.now);
  const [timer, due] = set[next.which % Math.max(1, set.length)] ?? [TimerId.make("none"), at];

  if (next.early) {
    return { _tag: "Fired", at, due: Instant.make(due - 1), timer };
  }

  fold.now = Math.max(at, due);

  return { _tag: "Fired", at: Instant.make(fold.now), due, timer };
};

// The input a move makes in the state it meets.
const inputOf = (
  fold: Fold,
  next: Exclude<Move, { readonly _tag: "Read" | "Act" | "Look" }>
): Input => {
  const at = Instant.make(fold.now);
  const current = client.inspect(fold.state).connection ?? ConnectionId.make(1);

  const connection = (stale: boolean) =>
    stale ? ConnectionId.make(Math.max(0, current - 1)) : current;

  switch (next._tag) {
    case "Configure": {
      return { _tag: "Configured", at, configuration: configurations[next.which] ?? configured() };
    }

    case "Started":
    case "Retry":
    case "Stopping": {
      return { _tag: next._tag, at };
    }

    // The last Lines sent on a Connection never left.
    case "Unsent": {
      const on = connection(next.stale);

      const sent = fold.steps.flatMap((step) =>
        step.outputs.filter(
          (output): output is UnsentLine =>
            (output._tag === "Send" || output._tag === "SendSecret") && output.connection === on
        )
      );

      return { _tag: "Unsent", at, connection: on, outputs: sent.slice(-next.count) };
    }

    case "Opened":
    case "Closed": {
      return next._tag === "Opened"
        ? { _tag: "Opened", at, connection: connection(next.stale) }
        : {
            _tag: "Closed",
            at,
            connection: connection(next.stale),
            reason: reasons[fold.now % 4] ?? "Ended",
          };
    }

    case "Received": {
      return { _tag: "Received", at, bytes: next.bytes, connection: connection(next.stale) };
    }

    case "Fire": {
      return fire(fold, next);
    }

    case "Wait": {
      return { _tag: "Retry", at };
    }

    case "Say": {
      return owned(fold, at, next);
    }

    case "Unfilled": {
      return {
        _tag: "Unfilled",
        at,
        connection: current,
        line: secrets[next.line] ?? secrets[0],
        reason: "Missing",
      };
    }

    default: {
      return next satisfies never;
    }
  }
};

// Every Message and Activity belongs somewhere, keyed by the mapping the Network last
// declared when the step began, which is Knowledge's whenever the Connection's mapping is
// the same, and a Quit or a nick change lists only Channels Self knew.
const declared = (state: State) => state.declared ?? defaultCasemapping;

// Ours is Self's, and Self is never a Highlight.
const checkSelf = (news: News): void => {
  if (news._tag === "Message") {
    expect(news.ours === undefined || news.self).toBeTruthy();
    expect(news.self && news.highlight).toBeFalsy();
  }
};

const checkWhere = (step: Step<State>, before: State): void => {
  const known = client.known(before);
  const fold = (name: string) => casefold(declared(before), name);
  const knownFold = (name: string) => casefold(known.casemapping, name);

  // The Network's mapping changes only with a `Refolded` that reports it, once.
  const refolded = step.news.flatMap((news) =>
    news._tag === "Refolded" ? [news.casemapping] : []
  );

  expect(refolded).toStrictEqual(
    declared(step.state) === declared(before) ? [] : [declared(step.state)]
  );

  for (const news of step.news) {
    // A Highlight is said live, by someone other than Self.
    if (news._tag === "Message" && news.highlight) {
      expect(news.live).toBeTruthy();
      expect(news.ours).toBeUndefined();
      expect(
        known.self === undefined || knownFold(news.sender) !== knownFold(known.self.nick)
      ).toBeTruthy();
    }

    checkSelf(news);

    // A Read Marker is keyed as `where` is, and only by the Owner's `Read`.
    if (news._tag === "ReadMarker") {
      expect(
        news.where._tag === "Network" || news.where.key === fold(news.where.name)
      ).toBeTruthy();
    }

    if (news._tag !== "Message" && news._tag !== "Activity") {
      continue;
    }

    expect(news.where.length).toBeGreaterThan(0);

    for (const each of news.where) {
      if (each._tag !== "Network") {
        expect(each.key).toBe(fold(each.name));

        if (known.casemapping === declared(before)) {
          expect(each.key).toBe(knownFold(each.name));
        }
      }

      if (each._tag === "DirectRenamed") {
        expect(each.to.key).toBe(fold(each.to.name));
      }

      if (
        each._tag === "Channel" &&
        news._tag === "Activity" &&
        (news.activity._tag === "Quit" || news.activity._tag === "NickChanged")
      ) {
        expect(known.channels.get(knownFold(each.name))?.standing).toBe("Joined");
      }
    }
  }
};

// Each Lookup is reported exactly once: after every step, the Looks not yet reported are
// exactly the Lookups a Connection holds, so none is reported twice, reported unasked,
// or dropped without a report. A Connection holds a bounded number.
const checkLookups = (fold: Fold, input: Input, step: Step<State>): void => {
  if (input._tag === "Look") {
    fold.looking.add(input.intent);
  }

  const reported = step.news.flatMap((news) => (news._tag === "LookedUp" ? [news.intent] : []));
  const unasked = reported.filter((intent) => !fold.looking.delete(intent));
  const held = (openOf(step.state)?.lookups ?? []).map((looking) => looking.intent);

  expect({
    bounded: held.length <= maxLookups,
    held: held.toSorted(),
    unasked,
  }).toStrictEqual({ bounded: true, held: [...fold.looking].toSorted(), unasked: [] });
};

// Every invariant one step must keep.
const check = (fold: Fold, input: Input, step: Step<State>, before: State): void => {
  const inspection = client.inspect(step.state);
  const was = client.inspect(before).connection;
  const knowledge = client.known(step.state);

  expect(impurity(step.state)).toBeUndefined();
  expect(inspection.timers).toStrictEqual(fold.table);

  for (const output of step.outputs) {
    if (output._tag === "Dial") {
      // One Connection at a time: a dial only when none is open, or this input ended it.
      expect(was === undefined || input._tag === "Closed" || input._tag === "Started").toBeTruthy();
      // Nothing is dialled between a `Stopping` and the next `Started`.
      expect(fold.stopping && input._tag !== "Started").toBeFalsy();
    }

    if (output._tag === "Send") {
      expect(isRejected(encode(output.line))).toBeFalsy();
    }

    if (output._tag === "Wake" && output.at !== null) {
      expect(output.at).toBeGreaterThanOrEqual(input.at);
    }
  }

  expect(Math.max(inspection.isupport.size, inspection.caps.offered.size)).toBeLessThanOrEqual(256);
  // The Channels the Owner wants, and at most 64 that Self was put in without asking.
  expect(knowledge.channels.size).toBeLessThanOrEqual(2 + 64);

  // Users kept are never more than the members kept: membership churn cannot grow them.
  const members = new Set(
    [...step.state.channels.values()].flatMap(({ phase }) =>
      phase._tag === "Joined"
        ? [
            ...phase.members.keys(),
            ...(phase.listing === undefined ? [] : listedMembers(phase.listing).keys()),
          ]
        : []
    )
  );

  const users = [...(openOf(step.state)?.users.keys() ?? [])];

  expect(users.filter((nick) => !members.has(nick))).toStrictEqual([]);

  // Only the Owner's `Read` moves a Read Marker, to the instant it gives.
  for (const news of step.news) {
    if (news._tag === "ReadMarker") {
      expect(input._tag === "Read" && news.read === input.read).toBeTruthy();
    }
  }

  checkLookups(fold, input, step);
  checkWhere(step, before);
};

// The input any move makes in the state it meets.
const inputFor = (fold: Fold, next: Exclude<Move, { readonly _tag: "Wait" }>): Input => {
  if (next._tag === "Read") {
    return {
      _tag: "Read",
      at: Instant.make(fold.now),
      read: Instant.make(epoch + next.read),
      target: next.target,
    };
  }

  return next._tag === "Act" || next._tag === "Look"
    ? owned(fold, Instant.make(fold.now), next)
    : inputOf(fold, next);
};

const runMoves = (moves: readonly Move[]): Fold => {
  const fold: Fold = {
    inputs: [],
    intents: 0,
    looking: new Set(),
    now: epoch,
    state: client.initial,
    steps: [],
    stopping: false,
    table: new Map(),
  };

  let dialled = 0;

  for (const next of moves) {
    if (next._tag === "Wait") {
      fold.now += next.millis;
      continue;
    }

    const input = inputFor(fold, next);

    const before = fold.state;
    const step = client.step(before, input);

    fold.table = timers(fold.table, input, step.outputs);

    if (input._tag === "Started") {
      fold.stopping = false;
    }

    check(fold, input, step, before);

    if (input._tag === "Stopping") {
      fold.stopping = true;
    }

    for (const output of step.outputs) {
      if (output._tag === "Dial") {
        dialled += 1;
        expect(output.connection).toBe(dialled);
      }
    }

    fold.inputs.push(input);
    fold.steps.push(step);
    fold.state = step.state;
    fold.now += 1;
  }

  return fold;
};

describe("properties", () => {
  it("reaches every machine's states, so the properties mean something", () => {
    const reached = new Map<string, number>();

    for (const moves of fc.sample(runOf(running), { numRuns: 200, seed: 1 })) {
      const fold = runMoves(moves);
      const states = fold.steps.map((step) => client.inspect(step.state).states);

      for (const each of states.flatMap((record) => Object.entries(record))) {
        reached.set(each.join("="), (reached.get(each.join("=")) ?? 0) + 1);
      }
    }

    const wanted = [
      "caps=None",
      "caps=Ready.Steady",
      "channel #iirc=Joined.Synced",
      "channel #iirc=Refused",
      "keepalive=Pinged",
      "modes=Asking",
      "network=Connection.Closing",
      "network=Idle",
      "network=Waiting",
      "presence=Session",
    ];

    expect(wanted.filter((state) => !reached.has(state))).toStrictEqual([]);
  });

  it("never throws, and keeps its invariants, for random and hostile input in any state", () => {
    expect(() => {
      fc.assert(
        fc.property(run, (moves) => {
          runMoves(moves);
        }),
        { numRuns: 400 }
      );
    }).not.toThrow();
  });

  it("folds the same moves to the same states, outputs, News, and views", () => {
    expect(() => {
      fc.assert(
        fc.property(run, (moves) => {
          const first = runMoves(moves);
          let state = client.initial;

          for (const [index, input] of first.inputs.entries()) {
            const step = client.step(state, input);
            const played = first.steps[index];

            expect(played === undefined ? undefined : snapshot(client, played)).toStrictEqual(
              snapshot(client, step)
            );
            ({ state } = step);
          }
        }),
        { numRuns: 100 }
      );
    }).not.toThrow();
  });
});
