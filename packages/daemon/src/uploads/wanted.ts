/**
 * What a `GET` or `HEAD` of an Upload's bytes wants, read from its conditional and range
 * headers, as RFC 9110 orders them: `If-None-Match` first, then `If-Range`, then `Range`.
 *
 * @packageDocumentation
 */

/**
 * What to answer: `Unchanged`, as the entity tag the request holds is current, `Whole`,
 * `Part`, from `start` up to but not including `end`, or `Unsatisfiable`, as the one range
 * asked for begins past the end.
 */
export type Wanted =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Whole" }
  | { readonly _tag: "Part"; readonly start: number; readonly end: number }
  | { readonly _tag: "Unsatisfiable" };

/** The parts of a request what it wants is read from, its header names in lower case. */
export interface Asking {
  readonly headers: Readonly<Record<string, string | undefined>>;
}

const whole: Wanted = { _tag: "Whole" };

const unsatisfiable: Wanted = { _tag: "Unsatisfiable" };

// An entity tag, weak or strong, as RFC 9110 writes one.
const entityTag = /(?:W\/)?"[!#-~\u0080-ÿ]*"/gu;

/**
 * Whether an `If-None-Match` holds an entity tag, compared weakly, or is `*`.
 * @param header - The header.
 * @param tag - The current entity tag, strong.
 * @returns Whether it does.
 */
const holds = (header: string, tag: string) =>
  header.trim() === "*" ||
  header.match(entityTag)?.some((each) => each.replace(/^W\//u, "") === tag) === true;

// One range of bytes: its first position, its last, or both.
const byteRange = /^(?<first>\d*)-(?<last>\d*)$/u;

/**
 * The one range of bytes a `Range` asks for, its positions as written, if it asks for
 * exactly one and it parses.
 * @param header - The header, if there is one.
 * @returns Its first and last positions, either of which may be empty, but not both.
 */
const oneRangeOf = (header: string | undefined) => {
  const ranges = /^bytes=(?<ranges>.*)$/iu.exec(header?.trim() ?? "")?.groups?.ranges;
  const each = ranges?.split(",").flatMap((range) => (range.trim() === "" ? [] : [range.trim()]));

  const { first = "", last = "" } =
    byteRange.exec(each?.length === 1 ? (each[0] ?? "") : "")?.groups ?? {};

  return first === "" && last === "" ? undefined : { first, last };
};

/**
 * What a `Range` asks of bytes of a size. A range of another unit, one that does not parse,
 * and several ranges are each answered as if no range were asked, as RFC 9110 allows.
 * @param header - The header, if there is one.
 * @param size - How many bytes there are.
 * @returns What it wants.
 */
const rangeOf = (header: string | undefined, size: number): Wanted => {
  const range = oneRangeOf(header);

  if (range === undefined) {
    return whole;
  }

  // The last so many bytes.
  if (range.first === "") {
    const suffix = Number(range.last);

    return suffix === 0 || size === 0
      ? unsatisfiable
      : { _tag: "Part", end: size, start: Math.max(0, size - suffix) };
  }

  const start = Number(range.first);
  const last = range.last === "" ? Infinity : Number(range.last);

  if (last < start) {
    return whole;
  }

  return start >= size ? unsatisfiable : { _tag: "Part", end: Math.min(last + 1, size), start };
};

/**
 * What a `GET` or `HEAD` of bytes wants.
 * @param asking - The request.
 * @param tag - The bytes' entity tag, strong, which never changes.
 * @param size - How many bytes there are.
 * @returns What it wants.
 */
export const wantedOf = ({ headers }: Asking, tag: string, size: number): Wanted => {
  const ifNoneMatch = headers["if-none-match"];

  if (ifNoneMatch !== undefined && holds(ifNoneMatch, tag)) {
    return { _tag: "Unchanged" };
  }

  // A part is answered only while the bytes it holds part of are current. A `HEAD` is
  // answered as its `GET` would be, as RFC 9110 asks of its headers, range and all.
  const ifRange = headers["if-range"];

  if (ifRange !== undefined && ifRange.trim() !== tag) {
    return whole;
  }

  return rangeOf(headers.range, size);
};
