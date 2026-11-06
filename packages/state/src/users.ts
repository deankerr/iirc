import { SortedMap } from "./sorted-map.ts";

/** What a Session has seen of another User (KNOW-7). Each field is unknown until seen. */
export interface User {
  /** The nick as the Ircd last spelled it. */
  readonly nick: string;
  readonly user: string | undefined;
  readonly host: string | undefined;
  /** From `311` or `352`. */
  readonly realname: string | undefined;
  /** From `301`, or the `H` or `G` of a `352`. */
  readonly away: boolean | undefined;
}

/**
 * How many Users a generation holds. Two are held, so at most twice this many Users are
 * remembered, and one not seen for a whole generation is forgotten.
 */
export const usersPerGeneration = 32_768;

/**
 * The Users a Session has seen, by casefolded nick, persistent and bounded. A User seen
 * again moves to the newest generation, and when that fills, the older one is forgotten
 * whole, so each change costs the same however many are held (HOST-1).
 */
export class SeenUsers {
  readonly #newer: SortedMap<User>;
  readonly #older: SortedMap<User>;

  private constructor(newer: SortedMap<User>, older: SortedMap<User>) {
    this.#newer = newer;
    this.#older = older;
  }

  /**
   * No Users at all.
   * @returns The empty record.
   */
  static empty(): SeenUsers {
    return new SeenUsers(SortedMap.empty(), SortedMap.empty());
  }

  /**
   * How many Users are held, at most twice {@link usersPerGeneration}. It counts the older
   * generation, so it is for tests and status, not for every Line.
   * @returns The count.
   */
  get size(): number {
    let { size } = this.#newer;

    for (const folded of this.#older.keys()) {
      size += this.#newer.has(folded) ? 0 : 1;
    }

    return size;
  }

  /**
   * The User by that casefolded nick, if seen.
   * @param folded - The nick, casefolded under the mapping in force.
   * @returns What was seen of them.
   */
  get(folded: string): User | undefined {
    return this.#newer.get(folded) ?? this.#older.get(folded);
  }

  /**
   * Every User held, newest generation first.
   */
  *values(): Generator<User> {
    yield* this.#newer.values();

    for (const [folded, user] of this.#older) {
      if (!this.#newer.has(folded)) {
        yield user;
      }
    }
  }

  /**
   * This record with a User seen as they are now.
   * @param folded - Their nick, casefolded.
   * @param user - What is known of them now.
   * @returns The record after it, or this one if nothing moved.
   */
  with(folded: string, user: User): SeenUsers {
    if (this.#newer.get(folded) === user) {
      return this;
    }

    const newer = this.#newer.with(folded, user);

    return newer.size > usersPerGeneration
      ? new SeenUsers(SortedMap.empty<User>().with(folded, user), this.#newer)
      : new SeenUsers(newer, this.#older);
  }

  /**
   * This record without a User, as after a `QUIT` or a nick change.
   * @param folded - Their nick, casefolded.
   * @returns The record after it, or this one if they were not held.
   */
  without(folded: string): SeenUsers {
    const newer = this.#newer.without(folded);
    const older = this.#older.without(folded);

    return newer === this.#newer && older === this.#older ? this : new SeenUsers(newer, older);
  }

  /**
   * The same Users, keyed by another fold, as after a new `CASEMAPPING`.
   * @param fold - The fold in force from now on.
   * @returns The record, keyed under it.
   */
  refolded(fold: (nick: string) => string): SeenUsers {
    const keyed = (users: SortedMap<User>) =>
      SortedMap.from([...users.values()].map((user) => [fold(user.nick), user] as const));

    return new SeenUsers(keyed(this.#newer), keyed(this.#older));
  }
}
