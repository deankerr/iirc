import { flow, Option, Schema } from "effect";

// What a diagnostic reads of a defect: a bare string, or an error's tag or name, and its
// message. Fields are read through the prototype, which is where an `Error` keeps `name`.
const Described = Schema.Union([
  Schema.String,
  Schema.Struct({
    _tag: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
  }),
]);

const described = Schema.decodeUnknownOption(Described);

// What stands in for certificate material in a diagnostic.
const certificate = "<certificate>";

// A PEM block, whole or cut off where the text ends.
const pemBlock = /-----BEGIN [^-]*-----[\s\S]*?(?:-----END [^-]*-----|$)/gu;

// Control characters are each one code unit, so splitting by unit is enough here.
const onOneLine = (text: string) =>
  text
    .split("")
    .map((unit) => (unit < " " || unit === "\u007F" ? " " : unit))
    .join("");

type Parsed = typeof Described.Type;

const partsOf = (parsed: Parsed): readonly (string | undefined)[] =>
  Schema.is(Schema.String)(parsed) ? [parsed] : [parsed._tag ?? parsed.name, parsed.message];

const worded = (parts: readonly (string | undefined)[]): string => {
  const text = parts
    .filter((part) => part !== undefined && part !== "")
    .join(": ")
    .replaceAll(pemBlock, certificate);

  const plain = onOneLine(text).trim();

  return plain === "" ? "an unknown defect" : plain;
};

/**
 * Words for a defect, fit for an Entry: its tag or name, and its message, on one line,
 * with any certificate or key in PEM cut out. An `Error`'s name is read from its
 * prototype. It is not bounded here: a reason is scrubbed of Credential values and only
 * then bounded, as it is recorded (LOG-6), so that no cut can leave part of a value that
 * scrubbing would no longer recognise. It parses whatever it is given, and never throws.
 * @param defect - Whatever was thrown or died with.
 * @returns The diagnostic, which is never empty.
 */
export const describeDefect = flow(
  described,
  Option.match({ onNone: () => [], onSome: partsOf }),
  worded
);
