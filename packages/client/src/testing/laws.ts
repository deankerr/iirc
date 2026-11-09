/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The laws walk a Knowledge generically, so a fact added to it anywhere is checked without changing them. */
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
import { canonical, difference } from "./plain.ts";
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
const outcome = <State>(subject: Subject<State>, played: Played<State>) => ({
  inspection: subject.client.inspect(played.state),
  knowledge: subject.client.known(played.state),
  news: played.steps.map((step) => step.news),
  outputs: played.steps.map((step) => step.outputs),
});

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

      const changed = differs(plain, outcome(subject, run(subject, transcript, declined)));

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

/**
 * **refines:** more caps only sharpen what fewer know. For each set of caps and each
 * larger one, every fact the smaller knows is there in the larger, and its case goes
 * only from unknown to stale to partial to known, never back.
 * It throws `LawBrokenError` for the first pair of caps and fact that break it.
 * @param subject - The Client, its Features, and the transcript.
 */
export const refines = <State>(subject: Subject<State>): void => {
  const sets = across(capsOf(subject));

  const known = new Map(
    sets.map((caps) => [caps, subject.client.known(run(subject, subject.transcript(caps)).state)])
  );

  for (const fewer of sets) {
    for (const more of sets) {
      if (more.length <= fewer.length || !fewer.every((cap) => more.includes(cap))) {
        continue;
      }

      const broken = walkFacts(known.get(fewer), known.get(more), "known", (left, right, path) => {
        const was = factTag(left);
        const now = factTag(right);

        return was !== undefined && (now === undefined || ranks[now] < ranks[was])
          ? `${path} was ${was} with ${named(fewer)}, but ${now ?? "missing"} with ${named(more)}`
          : undefined;
      });

      if (broken !== undefined) {
        throw new LawBrokenError(`refines: ${broken}`);
      }
    }
  }
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
 * as the transcript without the cap and then `after`, and the same Knowledge, except
 * where the first holds a stale fact.
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

      const visit = (left: unknown, right: unknown, path: string) =>
        factTag(left) === "Stale" || canonical(left) === canonical(right)
          ? undefined
          : `${path} is ${canonical(left)}, but never having had it gives ${canonical(right)}`;

      const broken =
        walkFacts(
          subject.client.known(had.state),
          subject.client.known(never.state),
          "known",
          visit
        ) ??
        walkFacts(
          subject.client.known(never.state),
          subject.client.known(had.state),
          "known",
          (left, right, path) => (factTag(right) === "Stale" ? undefined : visit(right, left, path))
        );

      if (broken !== undefined) {
        throw new LawBrokenError(`${where}, ${broken}`);
      }
    }
  }
};
