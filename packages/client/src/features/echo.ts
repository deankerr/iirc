/**
 * `labeled-response` with `echo-message`: a Message we say is sent with a `label`, and
 * the Ircd's answer for that label confirms or rejects it. Without `labeled-response`, an
 * echo cannot be told from a Message Self sent to itself, so the two are asked for only
 * together, and never kept apart.
 *
 * - **Egress.** While both are enabled, each `Say` is sent with the next label of the
 *   Connection, `l1`, `l2`, and on, and its Message reports that the Ircd will echo it.
 *   Each Line of an Owner's action is labelled the same way, so the Ircd's answer to it
 *   is tied to its intent.
 * - **Answers.** The answer is one Line with the label, or a batch whose `BATCH +` carries
 *   it, with batches opened inside that one. Its first `PRIVMSG` or `NOTICE` is the echo,
 *   which the core reports as `Confirmed`. Its first `FAIL`, `ACK`, or error numeric
 *   rejects the intent, and the core reports it `Refused`. A Line in it that is neither,
 *   such as a `WARN`, answers nothing. An action's answer is only ever its first `FAIL`
 *   or error numeric, which rejects it: an `ACK` ends it with nothing to report, and what
 *   the Ircd relays of it, such as a `TOPIC`, is read as any Line is. An action split over
 *   several labelled Lines is refused once, and each later rejection only uses up its label.
 * - **Never one without the other.** `labeled-response` depends on `batch`, which must be
 *   negotiated to use it, so labels need all three. The Feature is on while
 *   `echo-message` is enabled, and uses `labeled-response` and `batch`, asked for only
 *   when all three are offered and the Owner has not declined `batch`. When
 *   `echo-message` is left without either, whether the Ircd acknowledged only part or
 *   deleted one since, it gives `echo-message` up with `CAP REQ :-echo-message`, and
 *   until it is gone, a Message from Self is an echo nothing can tie to what we sent, so
 *   it is `Ignored`. When `labeled-response` is left without `echo-message`, the Feature
 *   is off, and gives it up the same way. `batch` is the `batch` Feature's own.
 * - **Lookups.** The Line of a Lookup is labelled the same way, and every Line of its
 *   answer, the labelled Line on its own or each Line of the batch that carries the
 *   label, is marked `within` its intent, rejections included, so the core collects the
 *   reply by label and never by the names it holds. The Line that ends the answer, the
 *   labelled Line on its own or the `BATCH -` of that batch, says so.
 * - **Bounds.** At most {@link maxPending} labels await an answer: past that, the oldest
 *   is forgotten, and its Message stays unconfirmed, as one the Ircd never answers does.
 *   An answer for a label not awaited, such as one forgotten, is read as any other Line.
 *
 * @packageDocumentation
 */
import { casefold } from "@iirc/protocol/casemapping";
import { isRejected, withTags } from "@iirc/protocol/line";
import type { Line } from "@iirc/protocol/line";

import type { Context, Feature, Meant } from "../feature.ts";
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

/**
 * What a label was sent for: the intent, whether it said a Message or acted, and whether
 * another Line of the same action was already refused, so its intent is not refused twice.
 */
interface Awaited {
  readonly intent: IntentId;
  readonly said: boolean;
  /** Whether it was sent for a Lookup, whose whole reply is marked `within` its intent. */
  readonly looked: boolean;
  readonly reported: boolean;
}

/** What the Feature holds for one Connection. */
interface Echoes {
  /** The number of the next label. */
  readonly next: number;
  /** Labels awaiting an answer, oldest first, with what each was sent for. */
  readonly pending: ReadonlyMap<string, Awaited>;
  /** Open batches of answers, by reference. */
  readonly batches: ReadonlyMap<string, Answering>;
}

const fresh: Echoes = { batches: new Map(), next: 1, pending: new Map() };

const echoMessage = CapName.make("echo-message");
const labeledResponse = CapName.make("labeled-response");
const batch = CapName.make("batch");

// Whether answers can be tied to what we sent: `labeled-response` is enabled, with the
// `batch` it depends on, as well as `echo-message`.
const labelling = (context: Context<Echoes>): boolean =>
  context.enabled(labeledResponse) && context.enabled(batch);

// Whether a Message was said by Self, as its source names it.
const bySelf = (meant: Meant, context: Context<Echoes>): boolean => {
  const { self, casemapping } = context.known;

  return (
    meant._tag === "Message" &&
    meant.ours === undefined &&
    self !== undefined &&
    casefold(casemapping, meant.sender) === casefold(casemapping, self.nick)
  );
};

// A Line that rejects an intent: an error numeric, or a `FAIL`.
const rejects = ({ command }: Line): boolean => command === "FAIL" || /^[45]\d\d$/u.test(command);

// A Line that settles an intent: a Message's echo, its rejection, or an `ACK`, which says
// the Ircd did nothing it would echo. An action is settled only by its rejection: what
// the Ircd says of its success, such as the `TOPIC` it relays, is read as any Line is.
const settles = (line: Line, awaited: Awaited): boolean =>
  rejects(line) ||
  (awaited.said &&
    (line.command === "PRIVMSG" || line.command === "NOTICE" || line.command === "ACK"));

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

// The Lookup whose answer a `BATCH -ref` ends: the batch that carried its label.
const lookupEnding = (own: Echoes, line: Line): IntentId | undefined => {
  const [reference] = line.params;

  const ending =
    reference?.startsWith("-") === true ? own.batches.get(reference.slice(1)) : undefined;

  const awaited = ending?.top === true ? own.pending.get(ending.label) : undefined;

  return awaited?.looked === true ? awaited.intent : undefined;
};

// Marks every label awaited for an intent as refused already.
const reportedFor = (
  pending: ReadonlyMap<string, Awaited>,
  intent: IntentId
): ReadonlyMap<string, Awaited> =>
  new Map(
    [...pending].map(([label, awaited]) => [
      label,
      awaited.intent === intent ? { ...awaited, reported: true } : awaited,
    ])
  );

/** The `labeled-response` and `echo-message` Feature. */
export const echo: Feature<Echoes> = {
  // Only `labeled-response` is left: give it up.
  absent: (context) =>
    context.enabled(labeledResponse) && !context.enabled(echoMessage)
      ? { drop: [labeledResponse] }
      : {},
  egress: (departure, context) => {
    if (departure.for._tag === "Protocol" || !labelling(context)) {
      return { value: departure };
    }

    const label = `l${context.own.next}`;
    const line = withTags(departure.line, { label });

    if (isRejected(line)) {
      return { value: departure };
    }

    const pending = new Map(context.own.pending).set(label, {
      intent: departure.for.intent,
      looked: departure.for._tag === "Looked",
      reported: false,
      said: departure.for._tag === "Said",
    });

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

    if (!labelling(context)) {
      return { value: arrival };
    }

    if (line.command === "BATCH") {
      const ends = lookupEnding(own, line);

      return {
        own: batchLine(own, line),
        value: ends === undefined ? arrival : { ...arrival, within: { ends: true, intent: ends } },
      };
    }

    const label = line.tags.get("label");
    const parent = line.tags.get("batch");
    const answers = label ?? (parent === undefined ? undefined : own.batches.get(parent)?.label);
    const awaited = answers === undefined ? undefined : own.pending.get(answers);

    if (answers === undefined || awaited === undefined) {
      return { value: arrival };
    }

    // A Lookup's reply is every Line of its answer, which the core collects for its
    // intent. A labelled Line on its own is the whole of it.
    if (awaited.looked) {
      const lone = label !== undefined;

      return {
        own: lone ? { ...own, pending: without(own.pending, answers) } : own,
        value: { ...arrival, within: { ends: lone, intent: awaited.intent } },
      };
    }

    // The first Line that settles the intent answers it. A labelled Line on its own is
    // the whole answer, whatever it is, so an action's `ACK` ends it with nothing to tie.
    if (settles(line, awaited)) {
      const pending = without(own.pending, answers);

      // An action split over several Lines is refused once: the first rejection answers
      // its intent, and the rest only use up their labels.
      if (awaited.reported) {
        return { own: { ...own, pending }, value: arrival };
      }

      return {
        own: { ...own, pending: rejects(line) ? reportedFor(pending, awaited.intent) : pending },
        value: { ...arrival, answers: awaited.intent },
      };
    }

    return label === undefined
      ? { value: arrival }
      : { own: { ...own, pending: without(own.pending, answers) }, value: arrival };
  },
  // Until `echo-message` is gone, an echo of ours cannot be told from a new Message.
  meaning: (meant, _arrival, context) => ({
    value: labelling(context)
      ? meant
      : meant.map((each): Meant =>
          bySelf(each, context) ? { _tag: "Ignored", reason: { _tag: "UnmatchedEcho" } } : each
        ),
  }),
  name: FeatureName.make("echo-message"),
  needs: { caps: [echoMessage] },
  own: fresh,
  // On without `labeled-response` or `batch`, or with one gone since: give it up.
  start: (context) => (labelling(context) ? {} : { drop: [echoMessage] }),
  uses: [labeledResponse, batch],
};
