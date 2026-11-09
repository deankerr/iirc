/**
 * The Feature seam, as the core runs it: which Features are on, each one's own state, and
 * calling their hooks in registry order. A hook that throws turns its Feature off for the
 * rest of the Connection, and is reported, so a throw replays the same way.
 *
 * @packageDocumentation
 */
import type { NetworkConfiguration } from "./configuration.ts";
import type { Context, Effects, Kept, Refined, Registration, Sendable } from "./feature.ts";
import type { CapName, FeatureName, Instant } from "./ids.ts";
import type { Knowledge } from "./known.ts";
import type { Registered } from "./registry.ts";

/** What one Connection holds for its Features. Plain data. */
export interface Seam {
  /** Each Feature's own state, once it has been on in this Connection. */
  readonly own: ReadonlyMap<FeatureName, unknown>;
  /** Features whose hook threw. They stay off until the Connection ends. */
  readonly failed: ReadonlySet<FeatureName>;
  /** Features holding registration open before `CAP END`. */
  readonly holding: ReadonlySet<FeatureName>;
}

/** A new Connection's Seam: nothing on, nothing held. */
export const freshSeam: Seam = {
  failed: new Set(),
  holding: new Set(),
  own: new Map(),
};

/** What decides which Features are on. */
export interface Offer {
  readonly offered: ReadonlyMap<CapName, string>;
  readonly enabled: ReadonlySet<CapName>;
  readonly isupport: ReadonlyMap<string, string>;
}

/**
 * Whether a Feature is on: every cap it needs is enabled, every token it needs is in
 * ISUPPORT, the Owner has not declined it, and none of its hooks has thrown.
 * @param feature - The Feature.
 * @param offer - What the Ircd offers now.
 * @param declined - What the Owner declined.
 * @param seam - The Connection's Seam.
 * @returns Whether it is on.
 */
const isOn = (
  feature: Registered,
  offer: Offer,
  declined: readonly FeatureName[],
  seam: Seam
): boolean =>
  !declined.includes(feature.name) &&
  !seam.failed.has(feature.name) &&
  (feature.needs.caps ?? []).every((cap) => offer.enabled.has(cap)) &&
  (feature.needs.tokens ?? []).every((token) => offer.isupport.has(token));

/**
 * The Features on now, in registry order.
 * @param registry - Every Feature.
 * @param offer - What the Ircd offers now.
 * @param declined - What the Owner declined.
 * @param seam - The Connection's Seam.
 * @returns Those on.
 */
export const featuresOn = (
  registry: readonly Registered[],
  offer: Offer,
  declined: readonly FeatureName[],
  seam: Seam
): readonly Registered[] => registry.filter((feature) => isOn(feature, offer, declined, seam));

/**
 * The caps a Feature asks for: those it needs, then those it uses.
 * @param feature - The Feature.
 * @returns Its caps.
 */
export const capsOf = (feature: Registered): readonly CapName[] => [
  ...(feature.needs.caps ?? []),
  ...(feature.uses ?? []),
];

/**
 * The caps worth asking for: those each Feature the Owner has not declined needs or
 * uses, when they are all offered and none is needed by a Feature the Owner declined,
 * less any already enabled, in registry order.
 * @param registry - Every Feature.
 * @param offer - What the Ircd offers now.
 * @param declined - What the Owner declined.
 * @returns The caps to request.
 */
export const capsWanted = (
  registry: readonly Registered[],
  offer: Offer,
  declined: readonly FeatureName[]
): readonly CapName[] => {
  // A cap a declined Feature needs is asked for by no other Feature either.
  const refused = new Set(
    registry
      .filter((feature) => declined.includes(feature.name))
      .flatMap((feature) => feature.needs.caps ?? [])
  );

  const wanted = registry.flatMap((feature) => {
    const caps = capsOf(feature);

    const asked =
      !declined.includes(feature.name) &&
      !caps.some((cap) => refused.has(cap)) &&
      caps.length > 0 &&
      caps.every((cap) => offer.offered.has(cap));

    return asked ? caps.filter((cap) => !offer.enabled.has(cap)) : [];
  });

  return [...new Set(wanted)];
};

/** What the core gives every hook to read, less the Feature's own state. */
export interface Reading {
  readonly at: Instant;
  readonly offer: Offer;
  readonly configuration: NetworkConfiguration;
  readonly known: Knowledge;
}

/** The effects of running one stage over the Features on. */
export interface Ran<V> {
  readonly value: V;
  readonly seam: Seam;
  readonly send: readonly Sendable[];
  /** Caps the Features asked to give up, in registry order. */
  readonly drop: readonly CapName[];
  /** Each Feature's say over registration, in registry order. */
  readonly registration: readonly (readonly [FeatureName, Registration])[];
  /** Features whose hook threw, in registry order. */
  readonly failed: readonly FeatureName[];
}

const contextFor = (feature: Registered, seam: Seam, reading: Reading): Context<unknown> => {
  const caps = new Set(capsOf(feature));

  return {
    at: reading.at,
    cap: (name) => (caps.has(name) ? reading.offer.offered.get(name) : undefined),
    configuration: reading.configuration,
    enabled: (name) => caps.has(name) && reading.offer.enabled.has(name),
    known: reading.known,
    own: seam.own.has(feature.name) ? seam.own.get(feature.name) : feature.own,
    token: (name) => reading.offer.isupport.get(name),
  };
};

/**
 * Runs one stage: each Feature's hook in turn, each refining what the one before
 * returned. A Feature without the hook passes the value on. A hook that throws leaves
 * the value as it was, and its Feature is off for the rest of the Connection.
 * @param features - The Features on, in registry order.
 * @param seam - The Connection's Seam.
 * @param reading - What every hook may read.
 * @param value - What the core derived.
 * @param hook - The stage's hook of a Feature, if it has one, applied to the value.
 * @returns The refined value and the effects.
 */
export const runStage = <V>(
  features: readonly Registered[],
  seam: Seam,
  reading: Reading,
  value: V,
  hook: (
    feature: Registered,
    value: V,
    context: Context<unknown>
  ) => Refined<V, unknown> | undefined
): Ran<V> => {
  let current = value;
  let { own, failed } = seam;
  const send: Sendable[] = [];
  const drop: CapName[] = [];
  const registration: (readonly [FeatureName, Registration])[] = [];
  const threw: FeatureName[] = [];

  for (const feature of features) {
    if (failed.has(feature.name)) {
      continue;
    }

    try {
      const refined = hook(feature, current, contextFor(feature, { ...seam, own }, reading));

      if (refined !== undefined) {
        current = refined.value;
        own = "own" in refined ? new Map(own).set(feature.name, refined.own) : own;
        send.push(...(refined.send ?? []));
        drop.push(...(refined.drop ?? []));

        if (refined.registration !== undefined) {
          registration.push([feature.name, refined.registration]);
        }
      }
    } catch {
      failed = new Set(failed).add(feature.name);
      threw.push(feature.name);
    }
  }

  return {
    drop,
    failed: threw,
    registration,
    seam: { ...seam, failed, own },
    send,
    value: current,
  };
};

/**
 * Runs a hook that has no value to refine, such as `start` or `expired`.
 * @param features - The Features to run it on.
 * @param seam - The Connection's Seam.
 * @param reading - What every hook may read.
 * @param hook - The hook of a Feature, if it has one.
 * @returns The effects.
 */
export const runEffects = (
  features: readonly Registered[],
  seam: Seam,
  reading: Reading,
  hook: (feature: Registered, context: Context<unknown>) => Effects<unknown> | undefined
): Ran<undefined> =>
  runStage(features, seam, reading, undefined, (feature, _value, context) => {
    const effects = hook(feature, context);

    return effects === undefined ? undefined : { ...effects, value: undefined };
  });

/**
 * The facts that go stale as Features turn off: those a Feature that was on and is now
 * off kept, unless a Feature still on keeps them too.
 * @param was - The Features on before.
 * @param now - The Features on after.
 * @returns The facts, once each.
 */
export const goneStale = (
  was: readonly Registered[],
  now: readonly Registered[]
): readonly Kept[] => [
  ...new Set(
    was
      .filter((feature) => !now.includes(feature))
      .flatMap((feature) => feature.keeps ?? [])
      .filter((fact) => !now.some((feature) => feature.keeps?.includes(fact) === true))
  ),
];
