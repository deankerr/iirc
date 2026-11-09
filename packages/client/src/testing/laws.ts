/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- The laws walk a Knowledge generically, so a fact added to it anywhere is checked without changing them. */
/**
 * The four laws a Client and its Features keep, run over every set of caps `across`
 * gives. Each law replays the suite's transcript, so it needs no `>>` written, and
 * throws `LawBrokenError` at the first case that breaks it.
 *
 * - **inert:** a Feature that is off changes nothing.
 * - **refines:** more caps only sharpen what fewer know.
 * - **replays:** replay gives the same states, outputs, and News.
 * - **deactivates:** after `CAP DEL`, behaviour matches never having had the cap,
 *   except for facts marked stale.
 *
 * @packageDocumentation
 */
import type { Client } from "../client.ts";
import type { NetworkConfiguration } from "../configuration.ts";
import type { Feature } from "../feature.ts";
import type { CapName } from "../ids.ts";
import { canonical, difference, impurity, textDifference } from "./plain.ts";
import { replay } from "./play.ts";
import type { Played } from "./play.ts";
import { across } from "./preludes.ts";

/** What the laws read of a Feature. */
export type LawFeature = Pick<Feature<unknown>, "name" | "needs" | "keeps">;

/** What the laws run: a Client, its Features, and a transcript for any set of caps. */
export interface Subject<State> {
  readonly client: Client<State>;
  readonly configuration: NetworkConfiguration;
  readonly features: readonly LawFeature[];
  /** The caps to range over. Left out, every cap the Features need. */
  readonly caps?: readonly string[];
  /**
   * The transcript with an Ircd that offers exactly these caps, such as
   * `registered(configuration, { offered: caps })` and then a body that reads the same for all.
   */
  readonly transcript: (caps: readonly CapName[]) => string;
}

/** A law that does not hold. The message names the law, the caps, and what differed. */
export class LawBrokenError extends Error {
  override readonly name = "LawBrokenError";
}

const capsOf = <State>(subject: Subject<State>): readonly string[] =>
  subject.caps ?? [...new Set(subject.features.flatMap(({ needs }) => needs.caps ?? []))];

const named = (caps: readonly string[]): string => (caps.length === 0 ? "no caps" : caps.join(" "));

const differs = (left: unknown, right: unknown): string | undefined =>
  difference(left, right, ["one", "the other"]);

const run = <State>(
  subject: Subject<State>,
  transcript: string,
  configuration = subject.configuration
): Played<State> => replay(subject.client, { configuration, transcript });

// What a run did: everything it output and said, and where it ended up.
// Written as canonical text at once, so a Client that hands back one shared view and
// changes it on the next call cannot make two runs compare equal.
const outcome = <State>(subject: Subject<State>, played: Played<State>): string =>
  canonical({
    inspection: subject.client.inspect(played.state),
    knowledge: subject.client.known(played.state),
    news: played.steps.map((step) => step.news),
    outputs: played.steps.map((step) => step.outputs),
  });

/**
 * A view the laws read, copied the moment it is obtained, so a later call that changes a
 * shared view cannot change it.
 * @param view - What `known` or `inspect` just gave.
 * @param what - What to call it if it is not plain data.
 * @returns A copy of it.
 */
const kept = <View>(view: View, what: string): View => {
  const notPlain = impurity(view, what);

  if (notPlain !== undefined) {
    throw new LawBrokenError(`the laws read only plain data, but ${notPlain}`);
  }

  return structuredClone(view);
};

/**
 * **inert:** a Feature that is off changes nothing. For each set of caps that leaves a
 * Feature off, declining it must change no output, News, Knowledge, or Inspection.
 * It throws `LawBrokenError` for the first Feature and caps that break it.
 * @param subject - The Client, its Features, and the transcript.
 */
export const inert = <State>(subject: Subject<State>): void => {
  for (const caps of across(capsOf(subject))) {
    const off = subject.features.filter(({ needs }) =>
      (needs.caps ?? []).some((cap) => !caps.includes(cap))
    );

    if (off.length === 0) {
      continue;
    }

    const transcript = subject.transcript(caps);
    const plain = outcome(subject, run(subject, transcript));

    for (const feature of off) {
      const declined = {
        ...subject.configuration,
        declined: [...new Set([...subject.configuration.declined, feature.name])],
      };

      const changed = textDifference(plain, outcome(subject, run(subject, transcript, declined)), [
        "one",
        "the other",
      ]);

      if (changed !== undefined) {
        throw new LawBrokenError(
          `inert: ${feature.name} is off with ${named(caps)}, yet declining it changed what the Client did\n${changed}`
        );
      }
    }
  }
};

type FactTag = "Unknown" | "Stale" | "Partial" | "Known";

const ranks: Readonly<Record<FactTag, number>> = { Known: 3, Partial: 2, Stale: 1, Unknown: 0 };

const factTag = (value: unknown): FactTag | undefined => {
  if (typeof value !== "object" || value === null || !("_tag" in value)) {
    return undefined;
  }

  const tag = value._tag;

  return tag === "Unknown" || tag === "Stale" || tag === "Partial" || tag === "Known"
    ? tag
    : undefined;
};

const keyName = (key: unknown): string => (typeof key === "string" ? key : canonical(key));

// Walks two Knowledges side by side, calling `visit` for each fact in `left` with its
// counterpart, and naming any key `left` has that `right` lacks.
const walkFacts = (
  left: unknown,
  right: unknown,
  path: string,
  visit: (left: unknown, right: unknown, path: string) => string | undefined
): string | undefined => {
  if (factTag(left) !== undefined) {
    return visit(left, right, path);
  }

  if (left instanceof Map) {
    if (!(right instanceof Map)) {
      return `${path} is not a Map in both`;
    }

    for (const [key, value] of left) {
      const at = `${path}.get(${keyName(key)})`;
      const found = right.has(key) ? walkFacts(value, right.get(key), at, visit) : `${at} is gone`;

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (typeof left !== "object" || left === null || left instanceof Set) {
    return undefined;
  }

  if (typeof right !== "object" || right === null) {
    return `${path} is gone`;
  }

  const others = new Map<string, unknown>(Object.entries(right));

  for (const [key, value] of Object.entries(left)) {
    const found = walkFacts(value, others.get(key), `${path}.${key}`, visit);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

// A fact's field, read without knowing its shape.
const fieldOf = (fact: unknown, key: string): unknown =>
  typeof fact === "object" && fact !== null ? new Map(Object.entries(fact)).get(key) : undefined;

// What a fact holds, as canonical texts: a set's members, in any order, or one value.
const contentsOf = (value: unknown): readonly string[] =>
  value instanceof Set
    ? [...value].map((member: unknown) => canonical(member)).toSorted()
    : [canonical(value)];

// A fact's value as a reader sees it: a set as `{a,b}`, in order, or the value itself.
const shown = (value: unknown): string =>
  value instanceof Set ? `{${contentsOf(value).join(",")}}` : contentsOf(value).join(",");

// Whether a refined fact keeps what the coarser one established: a known value stays the
// same, and a refined set holds every member of the partial set it refines.
const keepsContents = (
  left: unknown,
  right: unknown,
  path: string,
  names: string
): string | undefined => {
  const was = factTag(left);
  const now = factTag(right);

  if (was === "Known") {
    const before = shown(fieldOf(left, "value"));
    const after = shown(fieldOf(right, "value"));

    return before === after
      ? undefined
      : `${path} was known as ${before}, but as ${after} ${names}`;
  }

  if (was === "Partial") {
    const held = new Set(contentsOf(fieldOf(right, now === "Known" ? "value" : "atLeast")));
    const lost = contentsOf(fieldOf(left, "atLeast")).filter((member) => !held.has(member));

    return lost.length === 0 ? undefined : `${path} lost ${lost.join(", ")} ${names}`;
  }

  return undefined;
};

/**
 * **refines:** more caps only sharpen what fewer know. For each set of caps and each
 * larger one, every fact the smaller knows is there in the larger, and its case goes
 * only from unknown to stale to partial to known, never back. What was established stays:
 * a known value is the same, and a set holds every member of the partial set it refines.
 * It throws `LawBrokenError` for the first pair of caps and fact that break it.
 * @param subject - The Client, its Features, and the transcript.
 */
export const refines = <State>(subject: Subject<State>): void => {
  const sets = across(capsOf(subject));

  const known = new Map(
    sets.map((caps) => [
      caps,
      kept(subject.client.known(run(subject, subject.transcript(caps)).state), "known"),
    ])
  );

  for (const fewer of sets) {
    for (const more of sets) {
      if (more.length <= fewer.length || !fewer.every((cap) => more.includes(cap))) {
        continue;
      }

      const broken = walkFacts(known.get(fewer), known.get(more), "known", (left, right, path) => {
        const was = factTag(left);
        const now = factTag(right);

        if (was !== undefined && (now === undefined || ranks[now] < ranks[was])) {
          return `${path} was ${was} with ${named(fewer)}, but ${now ?? "missing"} with ${named(more)}`;
        }

        return keepsContents(left, right, path, `from ${named(fewer)} to ${named(more)}`);
      });

      if (broken !== undefined) {
        throw new LawBrokenError(`refines: ${broken}`);
      }
    }
  }
};

// Keys of a Map or an object, as canonical texts, with the value each names.
const entriesOf = (value: unknown): ReadonlyMap<string, unknown> | undefined => {
  if (value instanceof Map) {
    return new Map(
      [...value].map(([key, item]: readonly [unknown, unknown]) => [keyName(key), item])
    );
  }

  return typeof value === "object" &&
    value !== null &&
    !(value instanceof Set) &&
    !Array.isArray(value)
    ? new Map(Object.entries(value))
    : undefined;
};

// Compares two Knowledges whole, every leaf and key, and allows a difference only where
// the first holds a fact marked stale.
const sameExceptStale = (had: unknown, never: unknown, path: string): string | undefined => {
  if (factTag(had) === "Stale") {
    return undefined;
  }

  const left = factTag(had) === undefined ? entriesOf(had) : undefined;
  const right = factTag(never) === undefined ? entriesOf(never) : undefined;

  if (left === undefined || right === undefined) {
    const before = canonical(had);
    const after = canonical(never);

    return before === after
      ? undefined
      : `${path} is ${before}, but never having had it gives ${after}`;
  }

  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const at = had instanceof Map ? `${path}.get(${key})` : `${path}.${key}`;

    if (!left.has(key) || !right.has(key)) {
      return `${at} is there only ${left.has(key) ? "after CAP DEL" : "without ever having had it"}`;
    }

    const found = sameExceptStale(left.get(key), right.get(key), at);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

/**
 * **replays:** for every set of caps, replay gives the same states, outputs, and News,
 * and every state is plain data. `replay` checks this itself, so this runs it across.
 * It throws `ReplayMismatchError` for the first set of caps that breaks it.
 * @param subject - The Client, its Features, and the transcript.
 */
export const replays = <State>(subject: Subject<State>): void => {
  for (const caps of across(capsOf(subject))) {
    run(subject, subject.transcript(caps));
  }
};

/** What `deactivates` needs besides the subject. */
export interface Deactivation {
  /** What happens after the cap is deleted, the same for both runs. */
  readonly after: (caps: readonly CapName[]) => string;
  /** The Ircd's name in the `CAP DEL` Line. */
  readonly server?: string;
}

/**
 * **deactivates:** after `CAP DEL`, behaviour matches never having had the cap, except
 * for facts marked stale. For each cap and each set holding it, the transcript with that
 * set, a `CAP DEL` of the cap, and `after` must give the same outputs and News in `after`
 * as the transcript without the cap and then `after`, and the same Knowledge, whole,
 * every leaf and key, except where the first holds a fact marked stale.
 * It throws `LawBrokenError` for the first cap and set that break it.
 * @param subject - The Client, its Features, and the transcript up to the `CAP DEL`.
 * @param deactivation - What comes after it.
 */
export const deactivates = <State>(
  subject: Subject<State>,
  { after, server = "irc.test" }: Deactivation
): void => {
  const [nick] = subject.configuration.nicks;

  for (const caps of across(capsOf(subject))) {
    for (const cap of caps) {
      const without = caps.filter((other) => other !== cap);
      const deleted = `${subject.transcript(caps)}<< :${server} CAP ${nick} DEL :${cap}\n`;
      const start = run(subject, deleted).steps.length;
      const had = run(subject, `${deleted}${after(without)}`);
      const never = run(subject, `${subject.transcript(without)}${after(without)}`);
      const neverStart = run(subject, subject.transcript(without)).steps.length;
      const where = `deactivates: after CAP DEL :${cap} from ${named(caps)}`;

      const changed = differs(
        had.steps.slice(start).map(({ news, outputs }) => ({ news, outputs })),
        never.steps.slice(neverStart).map(({ news, outputs }) => ({ news, outputs }))
      );

      if (changed !== undefined) {
        throw new LawBrokenError(
          `${where}, the Client did not act as if it never had it\n${changed}`
        );
      }

      const broken = sameExceptStale(
        kept(subject.client.known(had.state), "known"),
        kept(subject.client.known(never.state), "known"),
        "known"
      );

      if (broken !== undefined) {
        throw new LawBrokenError(`${where}, ${broken}`);
      }
    }
  }
};
