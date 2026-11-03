/**
 * Which Channel mode letters take a parameter, and when, as `PREFIX` and `CHANMODES` from
 * `RPL_ISUPPORT` say (KNOW-2, KNOW-6).
 */
export interface ModeTypes {
  /** Letters that give a member a prefix, such as `o`. Each always takes a nick. */
  readonly prefix: string;
  /** `CHANMODES` type A: lists, such as `b`. Each always takes a parameter. */
  readonly list: string;
  /** Type B, such as `k`. Each always takes a parameter. */
  readonly always: string;
  /** Type C, such as `l`. Each takes a parameter only when it is set. */
  readonly whenSet: string;
  /** Type D: flags, which never take one. */
  readonly flags: string;
}

/** One letter of a `MODE`, set or unset, with the parameter it took if it took one. */
export interface ModeChange {
  readonly adding: boolean;
  readonly letter: string;
  readonly param?: string;
}

/**
 * What a `MODE`'s letters and parameters came to. `Uneven` is a `MODE` whose parameters
 * do not add up under the types in force, which KNOW-6 keeps raw, so nothing should act
 * on what it holds.
 */
export type ParsedModes =
  | { readonly _tag: "Parsed"; readonly changes: readonly ModeChange[] }
  | { readonly _tag: "Uneven"; readonly changes: readonly ModeChange[] };

const takesParam = (types: ModeTypes, letter: string, adding: boolean) =>
  types.prefix.includes(letter) ||
  types.list.includes(letter) ||
  types.always.includes(letter) ||
  (adding && types.whenSet.includes(letter));

// Ircds differ on whether an unset `k` carries the key, so one that finds nothing left
// takes nothing. Any other letter short of a parameter means the `MODE` does not add up.
const mayGoWithout = (types: ModeTypes, letter: string, adding: boolean) =>
  !adding && types.always.includes(letter);

/**
 * Parses a Channel `MODE`'s letters against its parameters, in order, so that
 * `+ok nick key` gives the nick to `o` and the key to `k` (KNOW-6). A letter the Network
 * never advertised takes no parameter.
 * @param params - The `MODE`'s parameters after its Target: the letters, then the rest.
 * @param types - Which letters take parameters, as a Session's `isupport.modes` holds them.
 * @returns Each change, and whether the parameters added up.
 */
export const parseModes = (params: readonly string[], types: ModeTypes): ParsedModes => {
  const [letters = "", ...rest] = params;
  const changes: ModeChange[] = [];
  let adding = true;
  let next = 0;
  let even = true;

  for (const letter of letters) {
    if (letter === "+" || letter === "-") {
      adding = letter === "+";
    } else if (!takesParam(types, letter, adding)) {
      changes.push({ adding, letter });
    } else if (next < rest.length) {
      changes.push({ adding, letter, param: rest[next] ?? "" });
      next += 1;
    } else {
      even &&= mayGoWithout(types, letter, adding);
      changes.push({ adding, letter });
    }
  }

  return even && next === rest.length ? { _tag: "Parsed", changes } : { _tag: "Uneven", changes };
};
