/**
 * `batch`: the Ircd groups Lines with `BATCH +ref type …` and `BATCH -ref`, and each
 * Line in a batch carries `batch=ref`. This Feature tracks the open batches, so a Line in
 * one carries its reference on to the later stages, and a batch may open inside another.
 * Lines are read as they arrive, never held back, whatever the batch's type, so a type the
 * Client does not know changes nothing. At most {@link maxOpen} batches are open at
 * once, and one that never closes is dropped when the Connection ends.
 *
 * @packageDocumentation
 */
import type { Arrival, Feature } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";

/** The most batches open at once. A Line in one opened past this carries none. */
export const maxOpen = 64;

/** An open batch. */
interface Open {
  readonly type: string;
  /** The batch it opened inside, if any. */
  readonly parent: string | undefined;
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

// `BATCH +ref type …` opens one, and `BATCH -ref` closes it, with any left open inside.
const opened = (batches: Batches, arrival: Arrival, parent: string | undefined): Batches => {
  const [reference, type] = arrival.line.params;
  const ref = reference?.slice(1) ?? "";

  if (reference?.startsWith("+") === true && ref !== "" && type !== undefined) {
    return batches.open.has(ref) || batches.open.size >= maxOpen
      ? batches
      : { open: new Map(batches.open).set(ref, { parent, type }) };
  }

  if (reference?.startsWith("-") === true && batches.open.has(ref)) {
    const closing = within(batches.open, ref);

    return { open: new Map([...batches.open].filter(([each]) => !closing.has(each))) };
  }

  return batches;
};

/** The `batch` Feature. */
export const batch: Feature<Batches> = {
  batch: (arrival, context) => {
    const tagged = arrival.line.tags.get("batch");
    const parent = tagged !== undefined && context.own.open.has(tagged) ? tagged : undefined;
    const carried = parent === arrival.batch ? arrival : { ...arrival, batch: parent };

    return arrival.line.command === "BATCH"
      ? { own: opened(context.own, arrival, parent), value: [carried] }
      : { value: [carried] };
  },
  name: FeatureName.make("batch"),
  needs: { caps: [CapName.make("batch")] },
  own: none,
};
