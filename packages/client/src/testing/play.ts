/**
 * Playing a transcript through a Client. `play` is strict, for hand-written scenarios:
 * it matches every `Send`, `SendSecret`, `Dial`, and `Hangup` in order, every `Ignored`,
 * and each `??` written. `replay` feeds a recorded fixture's inputs and reports what the
 * Client did, without matching. After either, the inputs are folded again from
 * `initial`, and the states, outputs, and News must be the same, and plain data.
 *
 * @packageDocumentation
 */
import type { SecretLine } from "@iirc/protocol/line";
import { Result } from "effect";

import type { Client, Step } from "../client.ts";
import type { NetworkConfiguration } from "../configuration.ts";
import { ConnectionId, Instant, IntentId, TimerId } from "../ids.ts";
import type { Input } from "../input.ts";
import type { News } from "../news.ts";
import type { Output, TimerTable } from "../output.ts";
import { timers } from "../output.ts";
import { describeNews, describeOutput } from "./describe.ts";
import { diff } from "./diff.ts";
import { canonical, hashText, impurity, textDifference } from "./plain.ts";
import { epoch, parse, printItem, writeInstant } from "./transcript.ts";
import type { Change, Item, Owner } from "./transcript.ts";

/** A scenario: the Configuration that `!! configure` starts from, and the transcript. */
export interface Scenario {
  readonly configuration: NetworkConfiguration;
  /** The transcript, or its parts in order, such as a prelude and a body. */
  readonly transcript: string | readonly string[];
}

/** What happened when a transcript was played. */
export interface Played<State> {
  /** Every input stepped, in order, as the Journal would hold them. */
  readonly inputs: readonly Input[];
  readonly steps: readonly Step<State>[];
  /** The state after the last step. */
  readonly state: State;
  /**
   * The transcript as the Client played it. For `play`, this is the scenario's own text.
   * For `replay`, it is a report: each input, then each output and News it made.
   */
  readonly transcript: string;
  /** Each `Ignored`, as `?? …`, after the input that caused it. */
  readonly ignored: readonly string[];
  /** The timers still set, as `timers` projects them from the inputs and outputs. */
  readonly timers: TimerTable;
  /** Each step, written down as canonical text the moment it was stepped. */
  readonly snapshots: readonly Snapshot[];
}

/**
 * One step, written down the moment it was stepped as a hash of each part's canonical
 * text, so nothing the Client does to its values afterwards can change what replay is
 * compared against, and a long scenario holds a few bytes a step rather than its text.
 */
export interface Snapshot {
  readonly state: string;
  readonly outputs: string;
  readonly news: string;
  readonly inspection: string;
  readonly knowledge: string;
}

type Part = keyof Snapshot;

const parts: readonly Part[] = ["state", "outputs", "news", "inspection", "knowledge"];

// Each part of a step as canonical text.
const texts = <State>(
  client: Client<State>,
  step: Step<State>
): Readonly<Record<Part, string>> => ({
  inspection: canonical(client.inspect(step.state)),
  knowledge: canonical(client.known(step.state)),
  news: canonical(step.news),
  outputs: canonical(step.outputs),
  state: canonical(step.state),
});

// A step's texts, hashed, so a hash and the text it came from are always the same text.
const hashes = (written: Readonly<Record<Part, string>>): Snapshot => ({
  inspection: hashText(written.inspection),
  knowledge: hashText(written.knowledge),
  news: hashText(written.news),
  outputs: hashText(written.outputs),
  state: hashText(written.state),
});

// One part of a step as canonical text, calling only the view it needs.
const partText = <State>(client: Client<State>, step: Step<State>, part: Part): string => {
  switch (part) {
    case "inspection": {
      return canonical(client.inspect(step.state));
    }

    case "knowledge": {
      return canonical(client.known(step.state));
    }

    case "news":
    case "outputs":
    case "state": {
      return canonical(step[part]);
    }

    default: {
      return part satisfies never;
    }
  }
};

/**
 * Writes one step down, as a hash of each part's canonical text.
 * @param client - The Client, for its views of the state.
 * @param step - The step, as it was just returned.
 * @returns Its snapshot.
 */
export const snapshot = <State>(client: Client<State>, step: Step<State>): Snapshot =>
  hashes(texts(client, step));

// The start of a long text, to show beside a failure.
const excerpt = (text: string): string => (text.length > 240 ? `${text.slice(0, 240)}…` : text);

/**
 * Explains a part of a step that replayed differently, as best it can. The replay's text
 * is the very text its hash came from. The first run kept only a hash, so its text is
 * rebuilt, and shown as `played` only when it matches that hash: state from the object
 * the step returned, outputs and News from the kit's own copies, and Inspection and
 * Knowledge by calling the view again, which may give another answer.
 * @param client - The Client.
 * @param first - The first run's step, as the kit kept it.
 * @param recorded - The hash recorded for this part when the step first returned.
 * @param part - The part that differs.
 * @param replayed - The replay's text for this part.
 * @returns What can be shown of the difference.
 */
const explain = <State>(
  client: Client<State>,
  first: Step<State> | undefined,
  recorded: string | undefined,
  part: Part,
  replayed: string
): string => {
  const rebuilt = first === undefined ? undefined : partText(client, first, part);

  if (rebuilt !== undefined && hashText(rebuilt) === recorded) {
    return textDifference(rebuilt, replayed) ?? `replayed ${excerpt(replayed)}`;
  }

  if (part === "inspection" || part === "knowledge") {
    const view = part === "inspection" ? "inspect" : "known";

    return `the first run's view could not be rebuilt: \`${view}\` gives a different answer when called again\nreplayed ${excerpt(replayed)}`;
  }

  if (part === "state") {
    return `the first run's state changed after it was returned: the object it returned no longer hashes as it did\nreplayed ${excerpt(replayed)}`;
  }

  return `the first run's ${part} could not be rebuilt from the kit's copy\nreplayed ${excerpt(replayed)}`;
};

/** A scenario that did not play as written. The message is a transcript diff. */
export class TranscriptMismatchError extends Error {
  override readonly name = "TranscriptMismatchError";
}

/** A Client that does not replay exactly, or whose State is not plain data. */
export class ReplayMismatchError extends Error {
  override readonly name = "ReplayMismatchError";
}

/** A scenario the kit cannot play, such as one that does not parse. */
export class ScenarioError extends Error {
  override readonly name = "ScenarioError";
}

type Visible = Exclude<Output, { readonly _tag: "Wake" }>;

// The most timers that may fire in one `+Ns`, so a Client that sets them forever is caught.
const maxFirings = 10_000;

const transcriptText = (transcript: Scenario["transcript"]): string => [transcript].flat().join("");

const itemsOf = (scenario: Scenario): readonly Item[] => {
  const parsed = parse(transcriptText(scenario.transcript));

  if (Result.isFailure(parsed)) {
    const { line, message, text } = parsed.failure;

    throw new ScenarioError(`line ${line} of the transcript is ${message}: ${text}`);
  }

  return parsed.success;
};

const apply = (configuration: NetworkConfiguration, change: Change): NetworkConfiguration => {
  switch (change._tag) {
    case "Join": {
      const channel =
        change.key === undefined
          ? { name: change.channel }
          : { key: change.key, name: change.channel };

      const kept = configuration.channels.filter(({ name }) => name !== change.channel);

      return { ...configuration, channels: [...kept, channel] };
    }

    case "Part": {
      return {
        ...configuration,
        channels: configuration.channels.filter(({ name }) => name !== change.channel),
      };
    }

    case "Enable":
    case "Disable": {
      return { ...configuration, enabled: change._tag === "Enable" };
    }

    case "Decline": {
      return configuration.declined.includes(change.feature)
        ? configuration
        : { ...configuration, declined: [...configuration.declined, change.feature] };
    }

    case "Accept": {
      return {
        ...configuration,
        declined: configuration.declined.filter((feature) => feature !== change.feature),
      };
    }

    default: {
      return change satisfies never;
    }
  }
};

/** Where a driver is: the clock, the Connection inputs come from, and what is set. */
interface Driver<State> {
  readonly client: Client<State>;
  now: Instant;
  state: State;
  table: TimerTable;
  configuration: NetworkConfiguration;
  /** How many `-> dial` items have been read. The nth dial is Connection n. */
  dialled: number;
  connection: ConnectionId;
  intents: number;
  secret: SecretLine | undefined;
  readonly inputs: Input[];
  readonly steps: Step<State>[];
  /** Each step written down at once, to replay against, and to catch a step that changes an earlier state. */
  readonly snapshots: Snapshot[];
}

const driver = <State>(
  client: Client<State>,
  configuration: NetworkConfiguration
): Driver<State> => ({
  client,
  configuration,
  connection: ConnectionId.make(1),
  dialled: 0,
  inputs: [],
  intents: 0,
  now: Instant.make(epoch),
  secret: undefined,
  snapshots: [],
  state: client.initial,
  steps: [],
  table: new Map(),
});

const describeInput = (input: Input): string => {
  if (input._tag === "Received") {
    return printItem({ _tag: "Received", bytes: input.bytes });
  }

  return `${input._tag} at ${input.at - epoch}ms`;
};

// A deep copy, where the value can be copied. One that cannot holds something a Client
// should not output anyway, and replay's snapshots still catch it changing.
const copied = <A>(value: A): A => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

// Steps an input, giving the Client its own copy, and fails a step that changed it.
const stepCopy = <State>(
  client: Client<State>,
  state: State,
  input: Input,
  where: () => string
): Step<State> => {
  const given = structuredClone(input);
  const returned = client.step(state, given);

  if (canonical(given) !== canonical(input)) {
    throw new ReplayMismatchError(
      `${where()} changed the input it was given, which a reducer must never do`
    );
  }

  return returned;
};

const stepInput = <State>(at: Driver<State>, fed: Input): Step<State> => {
  // The kit keeps its own copy of the input, to journal and replay, and the Client gets another.
  const input = structuredClone(fed);
  const given = at.state;
  const before = at.snapshots.at(-1)?.state ?? hashText(canonical(given));
  const number = at.steps.length + 1;

  const returned = stepCopy(
    at.client,
    given,
    input,
    () => `step ${number} (${describeInput(input)})`
  );

  const notPlain = impurity(returned.state);

  if (notPlain !== undefined) {
    throw new ReplayMismatchError(
      `State must be plain data, but after step ${number} (${describeInput(input)}) ${notPlain}`
    );
  }

  if (hashText(canonical(given)) !== before) {
    throw new ReplayMismatchError(
      `step ${number} changed the state it was given, which a reducer must never do`
    );
  }

  at.snapshots.push(snapshot(at.client, returned));

  // The kit reads its own copy of what the step said, so a Client that later changes the
  // arrays or values it returned cannot change what was matched.
  const step: Step<State> = {
    news: copied(returned.news),
    outputs: copied(returned.outputs),
    state: returned.state,
  };

  at.inputs.push(input);
  at.steps.push(step);
  at.state = step.state;
  at.table = timers(at.table, input, step.outputs);

  return step;
};

const ownerInput = <State>(at: Driver<State>, owner: Owner): Input => {
  switch (owner._tag) {
    case "Configure": {
      for (const change of owner.changes) {
        at.configuration = apply(at.configuration, change);
      }

      return { _tag: "Configured", at: at.now, configuration: at.configuration };
    }

    case "Say": {
      at.intents += 1;

      return {
        _tag: "Say",
        at: at.now,
        intent: IntentId.make(`i${at.intents}`),
        kind: owner.kind,
        target: owner.target,
        text: owner.text,
      };
    }

    case "Retry": {
      return { _tag: "Retry", at: at.now };
    }

    default: {
      return owner satisfies never;
    }
  }
};

// The next timer due by `until`: the earliest, and of those the first by id.
const nextDue = (table: TimerTable, until: number): readonly [TimerId, Instant] | undefined =>
  [...table]
    .filter(([, due]) => due <= until)
    .toSorted(([leftId, left], [rightId, right]) => left - right || (leftId < rightId ? -1 : 1))
    .at(0);

// Moves the clock on, firing each timer as it falls due, in order. A timer is one-shot:
// the `timers` projection drops it once its `Fired` is stepped, unless that step sets it
// again, exactly as the Runtime's table does on restart.
const advance = <State>(at: Driver<State>, millis: number): Step<State>[] => {
  const until = at.now + millis;
  const fired: Step<State>[] = [];

  for (let due = nextDue(at.table, until); due !== undefined; due = nextDue(at.table, until)) {
    if (fired.length >= maxFirings) {
      throw new ScenarioError(`more than ${maxFirings} timers fired in one step of the clock`);
    }

    const [timer, instant] = due;
    at.now = Instant.make(Math.max(at.now, instant));
    fired.push(stepInput(at, { _tag: "Fired", at: at.now, due: instant, timer }));
  }

  at.now = Instant.make(until);

  return fired;
};

// The steps an item feeds, if it feeds any, after any bookkeeping it does.
const feedSteps = <State>(at: Driver<State>, item: Item): Step<State>[] => {
  switch (item._tag) {
    case "Received": {
      return [
        stepInput(at, {
          _tag: "Received",
          at: at.now,
          bytes: item.bytes,
          connection: at.connection,
        }),
      ];
    }

    case "Opened": {
      return [stepInput(at, { _tag: "Opened", at: at.now, connection: at.connection })];
    }

    case "Closed": {
      return [
        stepInput(at, {
          _tag: "Closed",
          at: at.now,
          connection: at.connection,
          reason: item.reason,
        }),
      ];
    }

    case "Started": {
      return [stepInput(at, { _tag: "Started", at: at.now })];
    }

    case "Unfilled": {
      if (at.secret === undefined) {
        throw new ScenarioError(
          "`== unfilled` comes after a `>> {…}` placeholder, and none came before it"
        );
      }

      return [
        stepInput(at, {
          _tag: "Unfilled",
          at: at.now,
          connection: at.connection,
          line: at.secret,
          reason: item.reason,
        }),
      ];
    }

    case "Fired": {
      const timer = TimerId.make(item.timer);

      return [stepInput(at, { _tag: "Fired", at: at.now, due: Instant.make(item.due), timer })];
    }

    case "Owner": {
      return [stepInput(at, ownerInput(at, item.owner))];
    }

    case "Advance": {
      return advance(at, item.millis);
    }

    case "Dial": {
      at.dialled += 1;
      at.connection = ConnectionId.make(at.dialled);

      return [];
    }

    case "SentSecret": {
      at.secret = item.line;

      return [];
    }

    case "Connection": {
      at.connection = ConnectionId.make(item.connection);

      return [];
    }

    case "Sent":
    case "Hangup":
    case "Expect":
    case "Any":
    case "Comment":
    case "Blank": {
      return [];
    }

    default: {
      return item satisfies never;
    }
  }
};

interface Fed<State> {
  readonly input: Input;
  readonly step: Step<State>;
  /** Its place in the Journal, from 0. */
  readonly index: number;
}

// Feeds an item, and gives each input it stepped with what came of it.
const feed = <State>(at: Driver<State>, item: Item): readonly Fed<State>[] => {
  const steps = feedSteps(at, item);
  const base = at.inputs.length - steps.length;

  return steps.map((step, offset) => ({
    index: base + offset,
    input: at.inputs[base + offset] ?? { _tag: "Started", at: at.now },
    step,
  }));
};

type InputItem = Extract<
  Item,
  {
    readonly _tag:
      | "Received"
      | "Opened"
      | "Closed"
      | "Started"
      | "Unfilled"
      | "Fired"
      | "Owner"
      | "Advance";
  }
>;

const inputTags: ReadonlySet<Item["_tag"]> = new Set([
  "Received",
  "Opened",
  "Closed",
  "Started",
  "Unfilled",
  "Fired",
  "Owner",
  "Advance",
]);

const isInput = (item: Item): item is InputItem => inputTags.has(item._tag);

const visible = (outputs: readonly Output[]): readonly Visible[] =>
  outputs.filter((output): output is Visible => output._tag !== "Wake");

// Exact replay

/**
 * Checks exact replay: folding the inputs again from `initial` gives, at every step, the
 * same state, outputs, News, Inspection, and Knowledge as the snapshots written down when
 * they were first stepped, and every state is plain data. Snapshots are hashes taken the
 * moment a step returned, never live values, so a Client that reuses or changes what it
 * returned is caught. A step that changes its input fails too. On a mismatch, the failing
 * part is written out from the first run's own copy of that step and from the replay, and
 * diffed.
 * It throws `ReplayMismatchError` at the first step that differs, or the first state that is not plain.
 * @param client - The Client.
 * @param played - The inputs, the snapshots, and the steps of the first run, such as `play(…)`.
 */
export const checkReplay = <State>(
  client: Client<State>,
  played: Pick<Played<State>, "inputs" | "snapshots" | "steps">
): void => {
  let state = client.initial;
  const initialImpurity = impurity(state, "initial");

  if (initialImpurity !== undefined) {
    throw new ReplayMismatchError(`State must be plain data, but ${initialImpurity}`);
  }

  for (const [index, input] of played.inputs.entries()) {
    const where = `step ${index + 1} (${describeInput(input)})`;
    const replayed = stepCopy(client, state, input, () => where);
    const notPlain = impurity(replayed.state);

    if (notPlain !== undefined) {
      throw new ReplayMismatchError(`State must be plain data, but after ${where} ${notPlain}`);
    }

    const recorded = played.snapshots[index];
    // The replay's views are called once: its hashes and anything shown come from these texts.
    const written = texts(client, replayed);
    const again = hashes(written);
    const part = parts.find((each) => recorded?.[each] !== again[each]);

    if (part !== undefined) {
      throw new ReplayMismatchError(
        `${where} does not replay exactly: its ${part} differ\n${explain(
          client,
          played.steps[index],
          recorded?.[part],
          part,
          written[part]
        )}`
      );
    }

    ({ state } = replayed);
  }
};

// Strict play

interface Pending {
  readonly step: number;
}

interface PendingOutput extends Pending {
  readonly output: Visible;
}

interface PendingNews extends Pending {
  readonly news: News;
  readonly at: Instant;
}

const ignoredLine = (news: News, at: Instant): string => `?? ${describeNews(news, at)}`;

/**
 * Plays a hand-written scenario, strictly. Every `Send`, `SendSecret`, `Dial`, and
 * `Hangup` must be written, in order, before the next input. Every `Ignored` must be
 * written. A `??` must match a News of its step, in order. `...` allows anything up to
 * the next expectation. `Wake` is never written: the fake clock carries it.
 * It throws `TranscriptMismatchError` with a transcript diff, or `ReplayMismatchError`.
 * @param client - The Client.
 * @param scenario - The Configuration and the transcript.
 * @returns What happened, for further checks.
 */
export const play = <State>(client: Client<State>, scenario: Scenario): Played<State> => {
  const items = itemsOf(scenario);
  const at = driver(client, scenario.configuration);
  const actual: string[] = [];
  const ignored: string[] = [];
  let outputs: PendingOutput[] = [];
  let news: PendingNews[] = [];
  let skipping = false;
  // Dials written that matched nothing, by the Connection each numbered, so the Client's
  // dial is shown against the one it should have been.
  let missed: number[] = [];

  const lineOf = (output: Visible): string => {
    const line = describeOutput(output);

    if (output._tag === "Dial") {
      const next = missed[0] ?? at.dialled + 1;

      return output.connection === next
        ? line
        : `${line} (as connection ${output.connection}, not ${next})`;
    }

    return output.connection === at.connection
      ? line
      : `${line} (on connection ${output.connection}, not ${at.connection})`;
  };

  const flush = () => {
    if (!skipping) {
      for (const { output } of outputs) {
        actual.push(lineOf(output));

        if (output._tag === "Dial") {
          missed = missed.slice(1);
        }
      }

      actual.push(
        ...news.flatMap((pending) =>
          pending.news._tag === "Ignored" ? [ignoredLine(pending.news, pending.at)] : []
        )
      );
    }

    outputs = [];
    news = [];
  };

  const matchOutput = (expected: string): boolean => {
    const found = outputs.findIndex(({ output }) => lineOf(output) === expected);

    if (found === -1) {
      return false;
    }

    const { step } = outputs[found] ?? { step: 0 };

    if (!skipping) {
      actual.push(...outputs.slice(0, found).map(({ output }) => lineOf(output)));
    }

    outputs = outputs.slice(found + 1);

    if (skipping) {
      news = news.filter((pending) => pending.step >= step);
      skipping = false;
    }

    actual.push(expected);

    return true;
  };

  const matchNews = (tag: News["_tag"], text: string, expected: string) => {
    const found = news.findIndex(
      (pending, index) =>
        describeNews(pending.news, pending.at) === text &&
        (skipping || !news.slice(0, index).some(({ news: before }) => before._tag === "Ignored"))
    );

    if (found === -1) {
      const near = news.findIndex((pending) => pending.news._tag === tag);
      const candidate = news[near];

      if (candidate !== undefined) {
        actual.push(`?? ${describeNews(candidate.news, candidate.at)}`);
        news = news.filter((_pending, index) => index !== near);
      }

      return;
    }

    const { step } = news[found] ?? { step: 0 };
    news = news.slice(found + 1);

    if (skipping) {
      outputs = outputs.filter((pending) => pending.step >= step);
      skipping = false;
    }

    actual.push(expected);
  };

  for (const item of items) {
    const line = printItem(item);

    if (isInput(item)) {
      flush();
      actual.push(line);

      for (const { index, input, step } of feed(at, item)) {
        const time = input.at;
        outputs.push(...visible(step.outputs).map((output) => ({ output, step: index })));
        news.push(...step.news.map((made) => ({ at: time, news: made, step: index })));
        ignored.push(
          ...step.news.flatMap((made) => (made._tag === "Ignored" ? [ignoredLine(made, time)] : []))
        );
      }

      continue;
    }

    switch (item._tag) {
      case "Sent":
      case "SentSecret":
      case "Dial":
      case "Hangup": {
        if (!matchOutput(line) && item._tag === "Dial") {
          missed = [...missed, at.dialled + 1];
        }

        // Matched or not, a dial numbers the next Connection, and a placeholder names
        // what `== unfilled` refers to.
        feed(at, item);
        break;
      }

      case "Expect": {
        matchNews(item.news, item.text, line);
        break;
      }

      case "Any": {
        skipping = true;
        actual.push(line);
        break;
      }

      case "Connection":
      case "Comment":
      case "Blank": {
        feed(at, item);
        actual.push(line);
        break;
      }

      default: {
        item satisfies never;
      }
    }
  }

  flush();

  const expected = items.map(printItem);

  if (actual.join("\n") !== expected.join("\n")) {
    throw new TranscriptMismatchError(
      `The transcript did not play as written. - is the scenario, + is what the Client did.\n${diff(expected, actual)}`
    );
  }

  checkReplay(client, at);

  return {
    ignored,
    inputs: at.inputs,
    snapshots: at.snapshots,
    state: at.state,
    steps: at.steps,
    timers: at.table,
    transcript: `${actual.join("\n")}\n`,
  };
};

// Replay

const startsConfigured = (items: readonly Item[]): boolean => {
  const first = items.find(isInput);

  return first?._tag === "Owner" && first.owner._tag === "Configure";
};

/**
 * Replays a recorded fixture: feeds its `<<`, `==`, `+Ns`, and `!!` items, and reports
 * every output and News, without matching its `>>` and `->` items, which are the
 * recorder's, not the Client's. Its `-> dial` items still number the Connections, and
 * its placeholders name what `== unfilled` refers to. Unless its first input is an
 * `!! configure`, one is stepped first, since a Client does nothing until it is
 * configured.
 * It throws `ReplayMismatchError` if the Client does not replay exactly.
 * @param client - The Client.
 * @param scenario - The Configuration and the fixture.
 * @returns What happened. Its transcript is a report of every input, output, and News.
 */
export const replay = <State>(client: Client<State>, scenario: Scenario): Played<State> => {
  const fixture = itemsOf(scenario);

  const items: readonly Item[] = startsConfigured(fixture)
    ? fixture
    : [{ _tag: "Owner", owner: { _tag: "Configure", changes: [] } }, ...fixture];

  const at = driver(client, scenario.configuration);
  const report: string[] = [];
  const ignored: string[] = [];

  for (const item of items) {
    if (!isInput(item)) {
      feed(at, item);
      continue;
    }

    report.push(printItem(item));

    for (const { input, step } of feed(at, item)) {
      if (input._tag === "Fired" && item._tag === "Advance") {
        report.push(`# fired ${input.timer} at ${writeInstant(input.at)}`);
      }

      report.push(...visible(step.outputs).map((output) => describeOutput(output)));

      for (const made of step.news) {
        const line = `?? ${describeNews(made, input.at)}`;
        report.push(line);

        if (made._tag === "Ignored") {
          ignored.push(`${printItem(item)}\n${line}`);
        }
      }
    }
  }

  checkReplay(client, at);

  return {
    ignored,
    inputs: at.inputs,
    snapshots: at.snapshots,
    state: at.state,
    steps: at.steps,
    timers: at.table,
    transcript: `${report.join("\n")}\n`,
  };
};
