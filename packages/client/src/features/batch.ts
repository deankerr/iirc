/**
 * `batch`: the Ircd groups Lines with `BATCH +ref type …` and `BATCH -ref`, and each
 * Line in a batch carries `batch=ref`. This Feature tracks the open batches, so a Line in
 * one carries its reference on to the later stages, and a batch may open inside another.
 * Lines are read as they arrive, never held back, whatever the batch's type, so a type the
 * Client does not know changes nothing. At most {@link maxOpen} batches are open at
 * once, and one that never closes is dropped when the Connection ends, or when the cap
 * is deleted.
 *
 * A `netsplit` or `netjoin` batch opened outside any other, naming exactly two servers, is
 * a split: its `BATCH +`, the Lines tagged with it, and its `BATCH -` carry a
 * {@link SplitMark}, and the core decides from each Line whether the batch is what its
 * type says. Any other is read as a batch of a type the Client does not know. A Line in
 * a `netsplit` or `netjoin` batch carries no batch, split or not, so it is read as it
 * would be unbatched.
 *
 * @packageDocumentation
 */
import type { Arrival, Feature, SplitKind, SplitMark } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** The most batches open at once. A Line in one opened past this carries none. */
export const maxOpen = 64;

/** An open batch. */
interface Open {
  readonly type: string;
  /** The batch it opened inside, if any. */
  readonly parent: string | undefined;
  /** Whether it is a split, opened outside any other and naming two servers. */
  readonly split: boolean;
}

/** The batches open now, by reference. */
interface Batches {
  readonly open: ReadonlyMap<string, Open>;
}

const none: Batches = { open: new Map() };

// A batch and every batch opened inside it, at any depth.
const within = (open: ReadonlyMap<string, Open>, ref: string): ReadonlySet<string> => {
  const found = new Set([ref]);
  let grew = true;

  while (grew) {
    grew = false;

    for (const [each, { parent }] of open) {
      if (parent !== undefined && found.has(parent) && !found.has(each)) {
        found.add(each);
        grew = true;
      }
    }
  }

  return found;
};

const kinds: ReadonlyMap<string, SplitKind> = new Map([
  ["netsplit", "Netsplit"],
  ["netjoin", "Netjoin"],
]);

// A server is a word, so one that is empty or holds a space is no server.
const server = (name: string): boolean => name !== "" && !name.includes(" ");

// A split's opening: `BATCH +ref netsplit|netjoin server server`, outside any other batch.
// A server is a word, so one that is empty or holds a space is no server.
const splitOf = (
  params: readonly string[],
  parent: string | undefined
): Extract<SplitMark, { readonly _tag: "Opens" }> | undefined => {
  const [reference = "", type = "", first = "", second = ""] = params;
  const kind = kinds.get(type);

  return parent === undefined &&
    kind !== undefined &&
    params.length === 4 &&
    server(first) &&
    server(second)
    ? { _tag: "Opens", kind, ref: reference.slice(1), servers: [first, second] }
    : undefined;
};

// `BATCH +ref type …` opens one, and `BATCH -ref` closes it, with any left open inside.
const opened = (batches: Batches, arrival: Arrival, parent: string | undefined): Batches => {
  const [reference, type] = arrival.line.params;
  const ref = reference?.slice(1) ?? "";

  if (reference?.startsWith("+") === true && ref !== "" && type !== undefined) {
    const split = splitOf(arrival.line.params, parent) !== undefined;

    return batches.open.has(ref) || batches.open.size >= maxOpen
      ? batches
      : { open: new Map(batches.open).set(ref, { parent, split, type }) };
  }

  if (reference?.startsWith("-") === true && batches.open.has(ref)) {
    const closing = within(batches.open, ref);

    return { open: new Map([...batches.open].filter(([each]) => !closing.has(each))) };
  }

  return batches;
};

// Where a Line stands in a split: opening one, in one, or ending one, as the batches open
// before it, and after it, say.
const markOf = (
  before: Batches,
  after: Batches,
  arrival: Arrival,
  parent: string | undefined
): SplitMark | undefined => {
  if (parent !== undefined && before.open.get(parent)?.split === true) {
    return { _tag: "In", ref: parent };
  }

  const [reference = ""] = arrival.line.params;
  const ref = reference.slice(1);

  if (arrival.line.command !== "BATCH" || before.open.has(ref) === after.open.has(ref)) {
    return undefined;
  }

  if (reference.startsWith("-")) {
    return before.open.get(ref)?.split === true
      ? { _tag: "Ends", ref, whole: arrival.line.params.length === 1 }
      : undefined;
  }

  return after.open.get(ref)?.split === true ? splitOf(arrival.line.params, parent) : undefined;
};

/** The `batch` Feature. */
export const batch: Feature<Batches> = {
  batch: (arrival, context) => {
    const tagged = arrival.line.tags.get("batch");
    const parent = tagged !== undefined && context.own.open.has(tagged) ? tagged : undefined;

    const own =
      arrival.line.command === "BATCH" ? opened(context.own, arrival, parent) : context.own;

    const split = markOf(context.own, own, arrival, parent);

    // A Line of a `netsplit` or `netjoin` batch is read as it would be unbatched, whether the
    // batch is a split or not, and whatever becomes of it.
    const type = parent === undefined ? undefined : context.own.open.get(parent)?.type;
    const batch = type !== undefined && kinds.has(type) ? undefined : parent;

    const carried =
      batch === arrival.batch && split === arrival.split ? arrival : { ...arrival, batch, split };

    return own === context.own ? { value: [carried] } : { own, value: [carried] };
  },
  name: FeatureName.make("batch"),
  needs: { caps: [CapName.make("batch")] },
  own: none,
  // Turned on again, it knows of no batch: those open before were cancelled with the cap.
  start: () => ({ own: none }),
};
