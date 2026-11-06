import { casefold, SortedMap } from "@iirc/state";
import type { Casemapping } from "@iirc/state";

/**
 * How many Direct Message partners a generation holds. Two are held per Network, so at
 * most twice this many are remembered, and a partner with no row in their Timeline while
 * this many others began one is forgotten, which only costs their Timeline a later `QUIT`
 * or `NICK` (KNOW-8).
 */
export const partnersPerGeneration = 4096;

/**
 * One Network's Direct Message partners: every User with a place in the Log so far, this
 * Session or earlier, keyed by their nick casefolded under one mapping, with their nick as
 * spelled. It is the Log's fold that carries this, rebuilt by the same pass that writes the
 * rows, so it is no second source of truth.
 *
 * Persistent and bounded like `@iirc/state`'s Users: a partner whose Timeline gains a row
 * moves to the newer generation, and when that fills, the older is forgotten whole, so each
 * change costs the same however many are held, and a row for a partner already in the newer
 * generation changes nothing at all. Under another mapping, each generation is keyed again
 * from the spellings, so a partner is still found however the mapping in force folds them.
 */
export class Partners {
  /** The mapping the keys were folded under, or none before any partner is held. */
  readonly casemapping: Casemapping | undefined;
  readonly #newer: SortedMap<string>;
  readonly #older: SortedMap<string>;

  private constructor(
    casemapping: Casemapping | undefined,
    newer: SortedMap<string>,
    older: SortedMap<string>
  ) {
    this.casemapping = casemapping;
    this.#newer = newer;
    this.#older = older;
  }

  /**
   * No partners at all.
   * @returns The empty record.
   */
  static empty(): Partners {
    return new Partners(undefined, SortedMap.empty(), SortedMap.empty());
  }

  /**
   * Whether a User has a Direct Message place.
   * @param key - Their nick, casefolded under {@link casemapping}.
   * @returns Whether they are held.
   */
  has(key: string): boolean {
    return this.#newer.has(key) || this.#older.has(key);
  }

  /**
   * This record keyed under a mapping, which costs nothing when it already is. Two partners
   * the new mapping folds alike are one partner from then on.
   * @param casemapping - The mapping in force.
   * @returns The record, keyed under it.
   */
  under(casemapping: Casemapping): Partners {
    if (casemapping === this.casemapping) {
      return this;
    }

    const keyed = (generation: SortedMap<string>) =>
      SortedMap.from([...generation.values()].map((nick) => [casefold(casemapping, nick), nick]));

    return new Partners(casemapping, keyed(this.#newer), keyed(this.#older));
  }

  /**
   * This record with a row in a partner's Timeline.
   * @param key - Their nick, casefolded under {@link casemapping}.
   * @param nick - Their nick as spelled, from which a new mapping keys them again.
   * @returns The record after it, or this one if nothing moved.
   */
  with(key: string, nick: string): Partners {
    if (this.#newer.has(key)) {
      return this;
    }

    const newer = this.#newer.with(key, nick);

    return newer.size > partnersPerGeneration
      ? new Partners(this.casemapping, SortedMap.empty<string>().with(key, nick), this.#newer)
      : new Partners(this.casemapping, newer, this.#older);
  }
}
