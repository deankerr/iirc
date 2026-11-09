/**
 * `labeled-response` with `echo-message`: a Message we say is sent with a `label`, and
 * the Ircd's answer for that label confirms or rejects it. The two caps are only useful
 * together, so this one Feature needs both. Without `labeled-response`, an echo cannot be
 * told from a Message Self sent to itself, so nothing waits for one.
 *
 * - **Egress.** Each `Say` is sent with the next label, `l1`, `l2`, and on, and its
 *   Message reports that the Ircd will echo it.
 * - **Answers.** The answer is one Line with the label, or a batch whose `BATCH +` carries
 *   it, with batches opened inside that one. Its first `PRIVMSG` or `NOTICE` is the echo,
 *   which the core reports as `Confirmed`. Its first `FAIL`, `ACK`, or error numeric
 *   rejects the intent, and the core reports it `Refused`. A Line in it that is neither,
 *   such as a `WARN`, answers nothing.
 * - **Bounds.** At most {@link maxPending} labels await an answer: past that, the oldest
 *   is forgotten, and its Message stays unconfirmed, as one the Ircd never answers does.
 *   An answer for a label not awaited, such as one forgotten, is read as any other Line.
 *
 * @packageDocumentation
 */
import { withTags, isRejected } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import type { Feature } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import type { IntentId } from "../ids.ts";

/** The most labels awaiting an answer at once. */
export const maxPending = 64;

/** The most batches of answers tracked at once. */
const maxBatches = 64;

/** A batch of answers: the label it answers, and whether its `BATCH +` carried it. */
interface Answering {
  readonly label: string;
  readonly top: boolean;
}

/** What the Feature holds for one Connection. */
interface Echoes {
  /** The number of the next label. */
  readonly next: number;
  /** Labels awaiting an answer, oldest first, with the intent each was sent for. */
  readonly pending: ReadonlyMap<string, IntentId>;
  /** Open batches of answers, by reference. */
  readonly batches: ReadonlyMap<string, Answering>;
}

const fresh: Echoes = { batches: new Map(), next: 1, pending: new Map() };

// A Line that settles an intent: its echo, or a rejection.
const settles = ({ command }: Line): boolean =>
  command === "PRIVMSG" ||
  command === "NOTICE" ||
  command === "FAIL" ||
  command === "ACK" ||
  /^[45]\d\d$/u.test(command);

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);

  return next;
};

// `BATCH +ref` that carries an awaited label, or opens inside a batch of answers, is
// part of that answer. `BATCH -ref` of the batch that carried the label ends the answer.
const batchLine = (own: Echoes, line: Line): Echoes => {
  const [reference] = line.params;
  const ref = reference?.slice(1) ?? "";
  const label = line.tags.get("label");
  const parent = line.tags.get("batch");

  if (reference?.startsWith("+") === true && ref !== "") {
    const carried = label !== undefined && own.pending.has(label) ? label : undefined;
    const inside = parent === undefined ? undefined : own.batches.get(parent)?.label;
    const answers = carried ?? inside;

    return answers === undefined || own.batches.size >= maxBatches || own.batches.has(ref)
      ? own
      : {
          ...own,
          batches: new Map(own.batches).set(ref, { label: answers, top: carried !== undefined }),
        };
  }

  const ending = reference?.startsWith("-") === true ? own.batches.get(ref) : undefined;

  if (ending === undefined) {
    return own;
  }

  if (!ending.top) {
    return { ...own, batches: without(own.batches, ref) };
  }

  return {
    ...own,
    batches: new Map([...own.batches].filter(([, each]) => each.label !== ending.label)),
    pending: without(own.pending, ending.label),
  };
};

/** The `labeled-response` and `echo-message` Feature. */
export const echo: Feature<Echoes> = {
  egress: (departure, context) => {
    if (departure.for._tag !== "Said") {
      return { value: departure };
    }

    const label = `l${context.own.next}`;
    const line = withTags(departure.line, { label });

    if (isRejected(line)) {
      return { value: departure };
    }

    const pending = new Map(context.own.pending).set(label, departure.for.intent);

    for (const oldest of pending.keys()) {
      if (pending.size <= maxPending) {
        break;
      }

      pending.delete(oldest);
    }

    return {
      own: { ...context.own, next: context.own.next + 1, pending },
      value: { ...departure, echo: true, line },
    };
  },
  label: (arrival, context) => {
    const { own } = context;
    const { line } = arrival;

    if (line.command === "BATCH") {
      return { own: batchLine(own, line), value: arrival };
    }

    const label = line.tags.get("label");
    const parent = line.tags.get("batch");
    const answers = label ?? (parent === undefined ? undefined : own.batches.get(parent)?.label);
    const intent = answers === undefined ? undefined : own.pending.get(answers);

    if (answers === undefined || intent === undefined) {
      return { value: arrival };
    }

    // The first Line that settles the intent answers it. A labelled Line on its own is
    // the whole answer, whatever it is.
    if (settles(line)) {
      return {
        own: { ...own, pending: without(own.pending, answers) },
        value: { ...arrival, answers: intent },
      };
    }

    return label === undefined
      ? { value: arrival }
      : { own: { ...own, pending: without(own.pending, answers) }, value: arrival };
  },
  name: FeatureName.make("echo-message"),
  needs: { caps: [CapName.make("labeled-response"), CapName.make("echo-message")] },
  own: fresh,
};
