/**
 * Configuration as an option tree (ADR 0013): every field of a Network's Configuration is
 * an option with a dotted name, such as `network.libera.nicks`, whose type, description,
 * and starting value come from the annotations on the Client's own Schema. Nothing here
 * lists the options by hand: they are derived from the Schema's AST, so a new field is a
 * new option with no work in any Frontend.
 *
 * Each type has one text syntax, for `/set` and for display, which is parsed, never
 * validated, and an edit is a pure function of the Configuration it is applied to, so the
 * runtime can apply the same edit again to a Configuration read again after a conflict.
 * A Credential option is write-only: it shows the Credential's name and whether the Vault
 * holds it, never a value.
 *
 * The options under `ui` are the Owner's rather than any Network's, named `ui.<option>`,
 * and come from the contract's `UiOptions` the same way (ADR 0015). Every device shares
 * them, and a device may override any but those annotated shared only for itself, which
 * it never sends.
 *
 * The options under `store`, `uploads`, and `previews` are the Owner's too, each named in full, such as
 * `store.s3.bucket`, and come from the contract's `OwnerOptions` the same way. They are not
 * a device's, so no device overrides them.
 *
 * @packageDocumentation
 */
import type { NetworkId } from "@iirc/api";
import {
  OwnerOptionName,
  OwnerOptions,
  ownerDefaults,
  ownerOptionNames,
  ownerValueKept,
} from "@iirc/api/options";
import type { OwnerInForce } from "@iirc/api/options";
import { UiOptionName, UiOptions, uiDefaults, uiValueKept } from "@iirc/api/ui";
import type { FontFamily, UiInForce } from "@iirc/api/ui";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";
import type { IgnoreMask } from "@iirc/protocol/mask";
import {
  Exit,
  Number as Numbers,
  Option as Maybe,
  Predicate,
  Result,
  Schema,
  SchemaAST,
} from "effect";

import type { Parsed } from "./commands.ts";
import { effectiveUi, noOverrides, overridesHeld } from "./ui.ts";
import type { DeviceUi } from "./ui.ts";

/** The decoded form of a Network's Configuration. */
export type Configuration = NetworkConfiguration;

/** A value as JSON says it, which every value of a Configuration is. */
export type Json = Schema.Json;

/** An object as JSON says it. */
type Record = Schema.JsonObject;

/**
 * What an option holds, which decides its text syntax.
 *
 * - `Toggle`: `on` or `off`, and `true` or `false` too.
 * - `Text`: the text as typed, and `""` for none.
 * - `Choice`: one of `choices`, in any ASCII case.
 * - `ChoiceOrText`: one of `choices`, in any ASCII case, or else the text as typed, trimmed,
 *   such as a font: one served by name, or a family the device has by its own.
 * - `Integer`: a whole number from `minimum` to `maximum`, in decimal digits.
 * - `IntegerOrChoice`: one of `choices`, in any ASCII case, or else a whole number from
 *   `minimum` to `maximum`, in decimal digits, such as the widest line: `none`, or a count.
 * - `Decimal`: a number from `minimum` to `maximum` that need not be whole, in decimal
 *   digits, and a multiple of `step`, so it is exact however it is written.
 * - `Credential`: the name of a Credential, set by giving its value, which the Vault holds.
 * - `Texts`: a list, comma-separated, as WeeChat's are, never empty when `nonEmpty`.
 * - `Ircds`: Ircds, comma-separated, each `host/port`, TLS unless followed by the word
 *   `plain`. A port left out is 6697 with TLS and 6667 without.
 * - `Names`: a list of records keyed by their `name`, such as Channels, comma-separated by
 *   name. Each record's other fields are options of their own under its name.
 * - `Tagged`: one of `members`, by its tag in lower case, such as `none` or `sasl`. Each
 *   member's fields are options of their own under the option's name.
 * - `ChoiceByKey`: one of `choices` for each key, each `key=choice`, comma-separated, such
 *   as each Timeline's own Previews. A choice is in any ASCII case, and may be given by its
 *   first word alone where no other choice starts with it, such as `links` for `links only`.
 */
export type Kind =
  | { readonly _tag: "Toggle" }
  | { readonly _tag: "Text" }
  | { readonly _tag: "Choice"; readonly choices: readonly string[] }
  | { readonly _tag: "ChoiceOrText"; readonly choices: readonly string[] }
  | { readonly _tag: "Integer"; readonly minimum: number; readonly maximum: number }
  | {
      readonly _tag: "IntegerOrChoice";
      readonly choices: readonly string[];
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly _tag: "Decimal";
      readonly minimum: number;
      readonly maximum: number;
      readonly step: number;
    }
  | { readonly _tag: "Credential" }
  | { readonly _tag: "Texts"; readonly nonEmpty: boolean }
  | { readonly _tag: "Ircds" }
  | { readonly _tag: "Names"; readonly fields: readonly Field[] }
  | { readonly _tag: "Tagged"; readonly members: readonly Member[] }
  | { readonly _tag: "ChoiceByKey"; readonly choices: readonly string[] };

/** One member of a tagged union, and its fields. */
export interface Member {
  readonly tag: string;
  readonly fields: readonly Field[];
}

/**
 * What a new Network starts with for a field.
 *
 * - `Value`: a fixed value, from the Schema's `default` annotation.
 * - `FirstNick`: the first of its nicks, from `startsAs: "FirstNick"`.
 * - `Named`: for a Credential, the name the core derives from the option's own name.
 * - `Absent`: nothing, for an optional field.
 * - `Given`: nothing: it must be given.
 */
export type Starts =
  | { readonly _tag: "Value"; readonly value: Json }
  | { readonly _tag: "FirstNick" }
  | { readonly _tag: "Named" }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Given" };

/** One field of the Configuration, as its Schema describes it. */
export interface Field {
  readonly key: string;
  readonly kind: Kind;
  readonly description: string;
  readonly optional: boolean;
  readonly starts: Starts;
}

/** The path of an option below its Network, such as `["login", "account"]`. */
export type Path = readonly string[];

/**
 * What an option shows as its value.
 *
 * - `Shown`: its value in its text syntax.
 * - `Unset`: no value: an optional field left out, or a field of another member than the
 *   one in force.
 * - `Credential`: the Credential it names, and whether the Vault holds it: none while that
 *   is being read, and `NotKnown` when it could not be.
 * - `Reading`: not known yet, as the options it is among are still being read.
 */
export type Value =
  | { readonly _tag: "Reading" }
  | { readonly _tag: "Shown"; readonly text: string }
  | { readonly _tag: "Unset" }
  | {
      readonly _tag: "Credential";
      readonly name: string;
      readonly held: boolean | "NotKnown" | undefined;
    };

/**
 * The names of the Credentials the Vault holds, once read, `NotKnown` when they could not
 * be read, or none while they are being read.
 */
export type HeldNames = ReadonlySet<string> | "NotKnown" | undefined;

/**
 * Whether the Vault holds a Credential, as far as is known.
 * @param held - The names held.
 * @param credential - The Credential.
 * @returns Whether it is held, `NotKnown`, or none while being read.
 */
const heldOf = (held: HeldNames, credential: string) =>
  held === "NotKnown" || held === undefined ? held : held.has(credential);

/** One option of a Network's Configuration, as the options view lists it. */
export interface NetworkOption {
  readonly _tag: "Network";
  /** Its dotted name, such as `network.libera.login.account`. */
  readonly name: string;
  readonly network: NetworkId;
  readonly path: Path;
  readonly kind: Kind;
  readonly description: string;
  readonly value: Value;
  /** What a new Network starts with, in words or in its text syntax, or nothing when it must be given. */
  readonly starts: string | undefined;
  /** Whether `/unset` can return it to what a new Network starts with. */
  readonly unsettable: boolean;
}

/**
 * One option under `ui`, as the options view lists it: the value in effect on this device,
 * which is this device's override when it has one, and the value every device shares.
 */
export interface UiOption {
  readonly _tag: "Ui";
  /** Its dotted name, such as `ui.time`. */
  readonly name: string;
  readonly option: UiOptionName;
  readonly kind: Kind;
  readonly description: string;
  /** The value in effect here: this device's override, or else the shared one. */
  readonly value: Value;
  /** The value every device shares, its default until one is set, or unset while not yet read. */
  readonly shared: Value;
  /** This device's override, which wins over the shared value here, or none. */
  readonly device: Value | undefined;
  /**
   * What the view says of the value in effect here, if anything: that a font's family was
   * not found on this device.
   */
  readonly note: string | undefined;
  /** What it starts as, in its text syntax. */
  readonly starts: string | undefined;
  /** Whether `/unset` can return it to what it starts as, which every `ui` option can. */
  readonly unsettable: boolean;
}

/**
 * One option under `store`, `uploads`, or `previews`, as the options view lists it: the Owner's, so the
 * same on every device, and never overridden by one.
 */
export interface OwnerOption {
  readonly _tag: "Owner";
  /** Its full name, such as `store.s3.bucket`. */
  readonly name: string;
  readonly option: OwnerOptionName;
  readonly kind: Kind;
  readonly description: string;
  /** Its value: shown, unset, or for a Credential option, the Credential it names. */
  readonly value: Value;
  /** What it starts as, in its text syntax, or `unset`. */
  readonly starts: string | undefined;
  /** Whether `/unset` can return it to what it starts as, which every one can. */
  readonly unsettable: boolean;
}

/** One option, as the options view lists it. */
export type Option = NetworkOption | UiOption | OwnerOption;

/**
 * A change to one Network's Configuration, which is applied to the Configuration in force,
 * whatever it is, so it can be applied again after a conflict.
 *
 * - `Set`: an option to a value in its text syntax.
 * - `Unset`: an option back to what a new Network starts with, or left out when optional.
 * - `Point`: a Credential option to name a Credential.
 * - `Join`, `Part`: Channels added to, or taken from, the Channels wanted, by name.
 * - `PartTimeline`: the Channel a Channel Timeline was routed to taken from those wanted,
 *   by the Timeline's key, as the Daemon folded it.
 * - `Ignore`, `Unignore`: a mask added to, or taken from, the masks ignored, as the Network
 *   folds them.
 */
export type Edit =
  | { readonly _tag: "Set"; readonly path: Path; readonly text: string }
  | { readonly _tag: "Unset"; readonly path: Path }
  | { readonly _tag: "Point"; readonly path: Path; readonly credential: string }
  | { readonly _tag: "Join"; readonly channels: readonly string[] }
  | { readonly _tag: "Part"; readonly channels: readonly string[] }
  | { readonly _tag: "PartTimeline"; readonly key: string; readonly name: string }
  | { readonly _tag: "Ignore"; readonly mask: IgnoreMask }
  | { readonly _tag: "Unignore"; readonly mask: IgnoreMask };

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

// Reading the Schema's AST.

const annotations = (ast: SchemaAST.AST) => SchemaAST.resolve(ast) ?? {};

const descriptionOf = (ast: SchemaAST.AST): string => {
  const { description } = annotations(ast);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an annotation's value is unknown until read.
  return typeof description === "string" ? description : "";
};

const isCredential = (ast: SchemaAST.AST) => annotations(ast).identifier === "CredentialName";

const isIrcd = (ast: SchemaAST.AST) => annotations(ast).identifier === "IrcdAddress";

const stringLiteral = (ast: SchemaAST.AST): string | undefined =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a literal may be of any primitive type.
  ast._tag === "Literal" && typeof ast.literal === "string" ? ast.literal : undefined;

const literalsOf = (ast: SchemaAST.Union): readonly string[] | undefined => {
  const values = ast.types.map(stringLiteral);

  return values.every((one) => one !== undefined) ? values : undefined;
};

/**
 * What a number's checks say of it: whether it is whole, the step it is a multiple of, and
 * its bounds, when given.
 */
interface NumberChecks {
  whole: boolean;
  step: number | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
}

/** What a number with no checks is: not known to be whole, and unbounded. */
const nothingChecked: NumberChecks = {
  maximum: undefined,
  minimum: undefined,
  step: undefined,
  whole: false,
};

/**
 * What a number's checks say of it, from Effect's own `isInt`, `isMultipleOf`, and
 * `isBetween`, read by the ids they describe themselves with.
 * @param checks - The checks.
 * @param found - What was found before them.
 * @returns What they say, with what was found before.
 */
const numberChecks = (
  checks: readonly SchemaAST.Check<unknown>[],
  found: NumberChecks
): NumberChecks => {
  let said = found;

  for (const check of checks) {
    if (check._tag === "FilterGroup") {
      said = numberChecks(check.checks, said);
      continue;
    }

    const { representation } = check.annotations ?? {};
    const payload: unknown = representation?.payload;

    if (representation?.id === "effect/schema/isInt") {
      said = { ...said, whole: true };
    } else if (
      representation?.id === "effect/schema/isMultipleOf" &&
      Predicate.hasProperty(payload, "divisor") &&
      Predicate.isNumber(payload.divisor)
    ) {
      said = { ...said, step: payload.divisor };
    } else if (
      representation?.id === "effect/schema/isBetween" &&
      Predicate.hasProperty(payload, "minimum") &&
      Predicate.hasProperty(payload, "maximum") &&
      Predicate.isNumber(payload.minimum) &&
      Predicate.isNumber(payload.maximum)
    ) {
      said = { ...said, maximum: payload.maximum, minimum: payload.minimum };
    }
  }

  return said;
};

/**
 * The kind of a number, from its checks: bounded, and whole, or a multiple of a step, or
 * none, since no option is yet any other number.
 * @param ast - The number.
 * @returns Its kind, or none.
 */
const numberKindOf = (ast: SchemaAST.AST): Kind | undefined => {
  const { maximum, minimum, step, whole } = numberChecks(ast.checks ?? [], nothingChecked);

  if (minimum === undefined || maximum === undefined) {
    return undefined;
  }

  if (whole) {
    return { _tag: "Integer", maximum, minimum };
  }

  return step === undefined ? undefined : { _tag: "Decimal", maximum, minimum, step };
};

/**
 * The kind of a union of words and one whole number, such as `none` or a count, or none for
 * any other union.
 * @param ast - The union.
 * @returns Its kind, or none.
 */
const integerOrChoiceOf = (ast: SchemaAST.Union): Kind | undefined => {
  const numbers = ast.types.filter((one) => one._tag === "Number");
  const words = ast.types.filter((one) => one._tag !== "Number").map(stringLiteral);
  const [number, ...more] = numbers;
  const kind = number === undefined || more.length > 0 ? undefined : numberKindOf(number);

  if (kind?._tag !== "Integer" || words.length === 0) {
    return undefined;
  }

  const choices = words.filter((one) => one !== undefined);

  return choices.length === words.length
    ? { _tag: "IntegerOrChoice", choices, maximum: kind.maximum, minimum: kind.minimum }
    : undefined;
};

const tagOf = (ast: SchemaAST.Objects): string | undefined => {
  const tag = ast.propertySignatures.find((one) => one.name === "_tag")?.type;

  return tag === undefined ? undefined : stringLiteral(tag);
};

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/**
 * What a new Network starts with for a field, from its annotations.
 * @param ast - The field's AST.
 * @param kind - Its kind.
 * @returns What it starts with.
 */
const startsOf = (ast: SchemaAST.AST, kind: Kind): Starts => {
  const read = annotations(ast);
  const fixed = "default" in read ? decodeJson(read.default) : Maybe.none();

  if (ast.context?.isOptional === true) {
    return { _tag: "Absent" };
  }

  if (Maybe.isSome(fixed)) {
    return { _tag: "Value", value: fixed.value };
  }

  if (read.startsAs === "FirstNick") {
    return { _tag: "FirstNick" };
  }

  return kind._tag === "Credential" ? { _tag: "Named" } : { _tag: "Given" };
};

/**
 * The fields of a struct's AST, `_tag` aside, each of a kind an option can take.
 * @param ast - The struct.
 * @param kindOf - How a field's kind is read.
 * @returns Its fields, in the Schema's order.
 */
const fieldsOf = (
  ast: SchemaAST.Objects,
  kindOf: (field: SchemaAST.AST) => Kind | undefined
): readonly Field[] =>
  ast.propertySignatures.flatMap((property) => {
    const key = String(property.name);
    const kind = key === "_tag" ? undefined : kindOf(property.type);

    return kind === undefined
      ? []
      : [
          {
            description: descriptionOf(property.type),
            key,
            kind,
            optional: property.type.context?.isOptional === true,
            starts: startsOf(property.type, kind),
          },
        ];
  });

/**
 * The kind of a list, from its item's AST.
 * @param ast - The list.
 * @param kindOf - How a field's kind is read.
 * @returns Its kind, or none.
 */
const listKindOf = (
  ast: SchemaAST.Arrays,
  kindOf: (field: SchemaAST.AST) => Kind | undefined
): Kind | undefined => {
  const [item] = ast.rest;

  if (item?._tag === "String") {
    return { _tag: "Texts", nonEmpty: ast.elements.length > 0 };
  }

  if (item?._tag !== "Objects") {
    return undefined;
  }

  if (isIrcd(item)) {
    return { _tag: "Ircds" };
  }

  const named = fieldsOf(item, kindOf);

  return named.some((one) => one.key === "name" && one.kind._tag === "Text")
    ? { _tag: "Names", fields: named.filter((one) => one.key !== "name") }
    : undefined;
};

/**
 * The kind of a record from text keys to one of a few choices, from its AST.
 * @param ast - The record.
 * @returns Its kind, or none for any other object.
 */
const choiceByKeyOf = (ast: SchemaAST.Objects): Kind | undefined => {
  const [only, ...others] = ast.indexSignatures;

  if (ast.propertySignatures.length > 0 || only === undefined || others.length > 0) {
    return undefined;
  }

  const choices =
    only.parameter._tag === "String" && only.type._tag === "Union"
      ? literalsOf(only.type)
      : undefined;

  return choices === undefined ? undefined : { _tag: "ChoiceByKey", choices };
};

/**
 * The kind of a field, from its AST, or none for a shape no option can take.
 * @param ast - The field's AST.
 * @returns Its kind.
 */
const kindOf = (ast: SchemaAST.AST): Kind | undefined => {
  if (ast._tag === "Boolean") {
    return { _tag: "Toggle" };
  }

  if (ast._tag === "String") {
    return isCredential(ast) ? { _tag: "Credential" } : { _tag: "Text" };
  }

  if (ast._tag === "Number") {
    return numberKindOf(ast);
  }

  if (ast._tag === "Arrays") {
    return listKindOf(ast, kindOf);
  }

  if (ast._tag === "Objects") {
    return choiceByKeyOf(ast);
  }

  if (ast._tag !== "Union") {
    return undefined;
  }

  const choices = literalsOf(ast);

  if (choices !== undefined) {
    return { _tag: "Choice", choices };
  }

  const counted = integerOrChoiceOf(ast);

  if (counted !== undefined) {
    return counted;
  }

  const [named, text, ...others] = ast.types;

  if (named?._tag === "Union" && text?._tag === "String" && others.length === 0) {
    const either = literalsOf(named);

    if (either !== undefined && !isCredential(text)) {
      return { _tag: "ChoiceOrText", choices: either };
    }
  }

  const members = ast.types.flatMap((one) => {
    const tag = one._tag === "Objects" ? tagOf(one) : undefined;

    return tag === undefined || one._tag !== "Objects"
      ? []
      : [{ fields: fieldsOf(one, kindOf), tag }];
  });

  return members.length === ast.types.length ? { _tag: "Tagged", members } : undefined;
};

/** Every field of a Network's Configuration, derived once from its Schema. */
export const fields: readonly Field[] = fieldsOf(NetworkConfiguration.ast, kindOf);

/** Every option under `ui`, derived once from the contract's Schema. */
export const uiFields: readonly Field[] = fieldsOf(UiOptions.ast, kindOf);

/** Every option under `store`, `uploads`, and `previews`, keyed by its full name, derived once from the contract's Schema. */
export const ownerFields: readonly Field[] = fieldsOf(OwnerOptions.ast, kindOf);

// JSON.

const isRecord = (value: Json | undefined): value is Record =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON is told apart by its type.
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: Json | undefined): value is Schema.JsonArray => Array.isArray(value);

const listOf = (value: Json | undefined): readonly Json[] => (isList(value) ? value : []);

const textOf = (value: Json | undefined): string | undefined =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON is told apart by its type.
  typeof value === "string" ? value : undefined;

const texts = (value: Json | undefined): readonly string[] =>
  listOf(value).flatMap((one) => {
    const text = textOf(one);

    return text === undefined ? [] : [text];
  });

const records = (value: Json | undefined): readonly Record[] => listOf(value).filter(isRecord);

/**
 * A record with one key set, or left out when there is no value.
 * @param record - The record.
 * @param key - The key.
 * @param value - Its value, or none.
 * @returns The record after.
 */
const withKey = (record: Record, key: string, value: Json | undefined): Record =>
  Object.fromEntries([
    ...Object.entries(record).filter(([one]) => one !== key),
    ...(value === undefined ? [] : [[key, value] as const]),
  ]);

// Text syntax.

/** A port left out: with TLS, and without. */
export const defaultPorts = { plain: 6667, tls: 6697 } as const;

// A list is its elements, comma-separated. `\,`, `\\`, and `\ ` stand for a comma, a
// backslash, and a space within one, and spaces around an unescaped comma, or at either
// end, are dropped, so an element keeps a space at its edge only escaped. Empty text is
// no element, and a lone space is one empty element.

const escapable: ReadonlySet<string> = new Set([",", "\\", " "]);

/** A character of a list's text, and whether it was escaped. */
interface Read {
  readonly character: string;
  readonly escaped: boolean;
}

const trimmed = (element: readonly Read[]): string => {
  let first = 0;
  let last = element.length;

  while (first < last && element[first]?.character === " " && element[first]?.escaped === false) {
    first += 1;
  }

  while (
    last > first &&
    element[last - 1]?.character === " " &&
    element[last - 1]?.escaped === false
  ) {
    last -= 1;
  }

  return element
    .slice(first, last)
    .map((one) => one.character)
    .join("");
};

/**
 * A list, from its text.
 * @param text - The text.
 * @returns Its elements, or why the text is not a list.
 */
const parseList = (text: string): Parsed<readonly string[]> => {
  if (text === "") {
    return parsed([]);
  }

  const elements: string[] = [];
  let element: Read[] = [];
  // Code points, so a backslash is never taken from inside one.
  // oxlint-disable-next-line typescript/no-misused-spread -- an escape is per code point, and the text is kept whole between.
  const characters = [...text];

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";

    if (character === "\\") {
      const next = characters[index + 1];

      if (next === undefined || !escapable.has(next)) {
        return invalid(
          "In a list, \\ comes before a comma, a backslash, or a space, and nothing else."
        );
      }

      element.push({ character: next, escaped: true });
      index += 1;
    } else if (character === ",") {
      elements.push(trimmed(element));
      element = [];
    } else {
      element.push({ character, escaped: false });
    }
  }

  elements.push(trimmed(element));

  return parsed(elements);
};

const escapeElement = (element: string): string => {
  const inner = element.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
  const leading = /^ */u.exec(inner)?.[0].length ?? 0;
  const trailing = inner.length === leading ? 0 : (/ *$/u.exec(inner)?.[0].length ?? 0);

  return `${"\\ ".repeat(leading)}${inner.slice(leading, inner.length - trailing)}${"\\ ".repeat(trailing)}`;
};

/**
 * A list's text, which `parseList` reads back as the same elements.
 * @param elements - The elements.
 * @returns The text.
 */
const showList = (elements: readonly string[]): string =>
  elements.length === 1 && elements[0] === "" ? " " : elements.map(escapeElement).join(",");

/** One Ircd, as typed and shown: JSON, as the Configuration holds it. */
type Ircd = Readonly<{ host: string; port: number; tls: boolean }>;

/**
 * One Ircd, `host[/port]`, TLS unless the word `plain` follows. The old `-tls` and `+tls`
 * flags are refused, not read as part of the host, so a habit cannot silently choose the
 * wrong one.
 * @param text - The text.
 * @returns The Ircd, or why not.
 */
export const parseIrcd = (text: string): Parsed<Ircd> => {
  if (/\s[-+]tls$/iu.test(text)) {
    return invalid(
      `Write host/port for TLS, or host/port plain for plaintext: -tls and +tls are not read, in "${text}".`
    );
  }

  const word = /\s+plain$/iu.exec(text);
  const tls = word === null;
  const address = word === null ? text : text.slice(0, word.index);
  const withPort = /^(?<host>.*)\/(?<port>\d{1,5})$/su.exec(address)?.groups;
  const host = withPort?.host ?? address;

  if (host === "") {
    return invalid(
      `An Ircd needs a host, as host/port, with the word plain after it for plaintext, not "${text}".`
    );
  }

  if (withPort?.port === undefined) {
    return parsed({ host, port: tls ? defaultPorts.tls : defaultPorts.plain, tls });
  }

  const port = Number(withPort.port);

  return port >= 1 && port <= 65_535
    ? parsed({ host, port, tls })
    : invalid(`An Ircd's port is 1 to 65535, not "${withPort.port}".`);
};

/**
 * One Ircd's text, as `parseIrcd` reads it: its port always, and ` plain` when not TLS.
 * @param ircd - The Ircd, as JSON.
 * @returns The text.
 */
const showIrcd = (ircd: Record): string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON is told apart by its type.
  `${textOf(ircd.host) ?? ""}/${typeof ircd.port === "number" ? ircd.port : ""}${ircd.tls === false ? " plain" : ""}`;

const toggles: ReadonlyMap<string, boolean> = new Map([
  ["false", false],
  ["off", false],
  ["on", true],
  ["true", true],
]);

const lower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/**
 * Ircds, comma-separated.
 * @param text - The text.
 * @returns The Ircds, or why not.
 */
const parseIrcds = (text: string): Parsed<Json> => {
  const ircds: Ircd[] = [];
  const items = parseList(text);

  if (items._tag === "Invalid") {
    return items;
  }

  for (const item of items.value) {
    const ircd = parseIrcd(item);

    if (ircd._tag === "Invalid") {
      return ircd;
    }

    ircds.push(ircd.value);
  }

  return ircds.length === 0 ? invalid("Give at least one Ircd, as host/port.") : parsed(ircds);
};

/**
 * One of a list of choices, in any ASCII case.
 * @param choices - The choices.
 * @param text - The text.
 * @returns The choice, or why not.
 */
const choiceOf = (choices: readonly string[], text: string): Parsed<string> => {
  const wanted = lower(text.trim());
  const found = choices.find((one) => lower(one) === wanted);

  return found === undefined
    ? invalid(`Choose one of ${choices.join(", ")}, not "${text}".`)
    : parsed(found);
};

/**
 * One of a list of choices, in any ASCII case, or by its first word alone where no other
 * choice starts with that word.
 * @param choices - The choices.
 * @param text - The text.
 * @returns The choice, or why not.
 */
const choiceOrWordOf = (choices: readonly string[], text: string): Parsed<string> => {
  const chosen = choiceOf(choices, text);
  const wanted = lower(text.trim());
  const [only, ...others] = choices.filter((one) => lower(one).split(" ")[0] === wanted);

  return chosen._tag === "Parsed" || only === undefined || others.length > 0
    ? chosen
    : parsed(only);
};

/**
 * A choice for each key, each `key=choice`, comma-separated.
 * @param choices - The choices.
 * @param text - The text.
 * @returns The record, or why not.
 */
const parseChoiceByKey = (choices: readonly string[], text: string): Parsed<Json> => {
  const items = parseList(text);

  if (items._tag === "Invalid") {
    return items;
  }

  const record: { [key: string]: Json } = {};

  for (const item of items.value) {
    const equals = item.indexOf("=");
    const key = equals === -1 ? "" : item.slice(0, equals).trim();

    if (key === "") {
      return invalid(`Give each as key=choice, not "${item}".`);
    }

    if (Object.hasOwn(record, key)) {
      return invalid(`${key} is given more than once.`);
    }

    const choice = choiceOrWordOf(choices, item.slice(equals + 1));

    if (choice._tag === "Invalid") {
      return choice;
    }

    record[key] = choice.value;
  }

  return parsed(record);
};

/**
 * A whole number within an `Integer`'s bounds, in decimal digits.
 * @param bounds - The least and the most it may be.
 * @param text - The text.
 * @returns The number, or why not.
 */
const integerOf = (
  bounds: { readonly minimum: number; readonly maximum: number },
  text: string
): Parsed<number> => {
  const { maximum, minimum } = bounds;
  const trimmed = text.trim();
  const value = /^-?\d{1,16}$/u.test(trimmed) ? Number(trimmed) : undefined;

  return value === undefined || value < minimum || value > maximum
    ? invalid(`Give a whole number from ${minimum} to ${maximum}, not "${text}".`)
    : parsed(value);
};

/**
 * A number within a `Decimal`'s bounds, in decimal digits, that is a multiple of its step.
 * Effect's own `remainder` is exact in decimal, so no rounding of binary fractions decides.
 * @param bounds - The least and the most it may be, and the step.
 * @param text - The text.
 * @returns The number, or why not.
 */
const decimalOf = (
  bounds: { readonly minimum: number; readonly maximum: number; readonly step: number },
  text: string
): Parsed<number> => {
  const { maximum, minimum, step } = bounds;
  const trimmed = text.trim();
  const value = /^\d{1,16}(?:\.\d{1,16})?$/u.test(trimmed) ? Number(trimmed) : undefined;

  return value === undefined ||
    value < minimum ||
    value > maximum ||
    Numbers.remainder(value, step) !== 0
    ? invalid(`Give a number from ${minimum} to ${maximum}, in steps of ${step}, not "${text}".`)
    : parsed(value);
};

/**
 * One of an `IntegerOrChoice`'s choices, or a whole number within its bounds.
 * @param kind - The kind.
 * @param text - The text.
 * @returns The value, or why not.
 */
const integerOrChoiceText = (
  kind: Extract<Kind, { readonly _tag: "IntegerOrChoice" }>,
  text: string
): Parsed<Json> => {
  const chosen = choiceOf(kind.choices, text);
  const counted = chosen._tag === "Parsed" ? chosen : integerOf(kind, text);

  return counted._tag === "Parsed"
    ? counted
    : invalid(
        `Give a whole number from ${kind.minimum} to ${kind.maximum}, or ${kind.choices.map(lower).join(", ")}, not "${text}".`
      );
};

/**
 * A number's text, as JSON holds it.
 * @param value - The value.
 * @returns Its digits, or nothing for anything but a number.
 */
const numberText = (value: Json): string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON is told apart by its type.
  typeof value === "number" ? String(value) : "";

/**
 * A choice for each key, as `parseChoiceByKey` reads it.
 * @param value - The record, as JSON.
 * @returns The text.
 */
const showChoiceByKey = (value: Json): string =>
  showList(
    Object.entries(isRecord(value) ? value : {}).map(
      ([key, choice]) => `${key}=${textOf(choice) ?? ""}`
    )
  );

/**
 * A value of a kind, from its text syntax. A `Names` list gives its names, and a `Tagged`
 * one its tag.
 * @param kind - The kind.
 * @param text - The text.
 * @returns The value, or why the text is not one.
 */
export const parseText = (kind: Kind, text: string): Parsed<Json> => {
  switch (kind._tag) {
    case "Toggle": {
      const value = toggles.get(lower(text.trim()));

      return value === undefined ? invalid(`Say on or off, not "${text}".`) : parsed(value);
    }

    case "Text": {
      return parsed(text);
    }

    case "Choice": {
      return choiceOf(kind.choices, text);
    }

    case "ChoiceOrText": {
      const chosen = choiceOf(kind.choices, text);

      return chosen._tag === "Parsed" ? chosen : parsed(text.trim());
    }

    case "Integer": {
      return integerOf(kind, text);
    }

    case "IntegerOrChoice": {
      return integerOrChoiceText(kind, text);
    }

    case "Decimal": {
      return decimalOf(kind, text);
    }

    case "Credential": {
      return invalid("A Credential is set by giving its value, which the Vault holds.");
    }

    case "Texts": {
      const items = parseList(text);

      if (items._tag === "Invalid") {
        return items;
      }

      return kind.nonEmpty && items.value.length === 0
        ? invalid("Give at least one, comma-separated.")
        : parsed(items.value);
    }

    case "Ircds": {
      return parseIrcds(text);
    }

    case "Names": {
      return parseList(text);
    }

    case "Tagged": {
      return choiceOf(
        kind.members.map((one) => one.tag),
        text
      );
    }

    case "ChoiceByKey": {
      return parseChoiceByKey(kind.choices, text);
    }

    default: {
      return kind satisfies never;
    }
  }
};

/**
 * A value of a kind in its text syntax, which `parseText` reads back as the same value.
 * @param kind - The kind.
 * @param value - The value, as the Configuration holds it.
 * @returns The text.
 */
export const showText = (kind: Kind, value: Json): string => {
  switch (kind._tag) {
    case "Toggle": {
      return value === true ? "on" : "off";
    }

    case "Text":
    case "Choice":
    case "ChoiceOrText":
    case "Credential": {
      return textOf(value) ?? "";
    }

    case "Integer":
    case "Decimal": {
      return numberText(value);
    }

    case "IntegerOrChoice": {
      return textOf(value) ?? numberText(value);
    }

    case "Texts": {
      return showList(texts(value));
    }

    case "Ircds": {
      return showList(records(value).map(showIrcd));
    }

    case "Names": {
      return showList(records(value).map((one) => textOf(one.name) ?? ""));
    }

    case "Tagged": {
      return isRecord(value) ? lower(textOf(value._tag) ?? "") : "";
    }

    case "ChoiceByKey": {
      return showChoiceByKey(value);
    }

    default: {
      return kind satisfies never;
    }
  }
};

// Names.

/** What a name that names no option is told, of how options are named. */
const optionsAreNamed =
  "Options are named network.<id>.<option>, ui.<option>, store.<option>, uploads.<option>, or previews.<option>.";

const networkIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/**
 * Whether text is a Network's id, as the API takes it: 1 to 64 lower-case letters,
 * digits, `.`, `_`, or `-`, starting with a letter or digit. The pattern is the API's own.
 * @param text - The text.
 * @returns Whether it is one.
 */
const isNetworkId = (text: string): text is NetworkId => networkIdPattern.test(text);

/**
 * A Network's id, as the API takes it.
 * @param text - The text.
 * @returns The id, or none.
 */
export const networkIdOf = (text: string): NetworkId | undefined =>
  isNetworkId(text) ? text : undefined;

/**
 * An option's dotted name.
 * @param network - Its Network.
 * @param path - Its path.
 * @returns The name.
 */
export const optionName = (network: string, path: Path): string =>
  ["network", network, ...path].join(".");

/** What a name resolves to: the option's Network, its path, and its field. */
export interface Resolved {
  readonly network: NetworkId;
  readonly path: Path;
  readonly field: Field;
}

const fieldNamed = (within: readonly Field[], key: string) => within.find((one) => one.key === key);

/**
 * The path below a Network that a dotted text names, and its field.
 * @param rest - The text after the Network's id.
 * @returns The path and its field, or none.
 */
const resolvePath = (rest: string): { readonly path: Path; readonly field: Field } | undefined => {
  const dot = rest.indexOf(".");
  const key = dot === -1 ? rest : rest.slice(0, dot);
  const top = fieldNamed(fields, key);

  if (top === undefined) {
    return undefined;
  }

  if (dot === -1) {
    return { field: top, path: [key] };
  }

  const below = rest.slice(dot + 1);

  if (top.kind._tag === "Tagged") {
    const sub = fieldNamed(
      top.kind.members.flatMap((member) => member.fields),
      below
    );

    return sub === undefined ? undefined : { field: sub, path: [key, below] };
  }

  if (top.kind._tag === "Names") {
    // A name may hold dots, and a field's key never does, so the key is after the last.
    const last = below.lastIndexOf(".");
    const sub = last === -1 ? undefined : fieldNamed(top.kind.fields, below.slice(last + 1));
    const name = below.slice(0, last);

    return sub === undefined || name === ""
      ? undefined
      : { field: sub, path: [key, name, sub.key] };
  }

  return undefined;
};

/**
 * The option a dotted name names, read from the Schema alone: `network.<id>.<path>`. A
 * Network's id may hold dots, so each split is tried, and the name is an option's only
 * when exactly one gives a valid id and a path the Schema has.
 * @param name - The name.
 * @returns The option's Network, path, and field, or why it names none.
 */
export const resolve = (name: string): Parsed<Resolved> => {
  const prefix = "network.";

  if (!name.startsWith(prefix)) {
    return invalid(`There is no option ${name}. ${optionsAreNamed}`);
  }

  const rest = name.slice(prefix.length);
  const found: Resolved[] = [];

  for (let dot = rest.indexOf("."); dot !== -1; dot = rest.indexOf(".", dot + 1)) {
    const network = networkIdOf(rest.slice(0, dot));
    const at = network === undefined ? undefined : resolvePath(rest.slice(dot + 1));

    if (network !== undefined && at !== undefined) {
      found.push({ ...at, network });
    }
  }

  const [only] = found;

  if (only === undefined) {
    return invalid(`There is no option ${name}.`);
  }

  return found.length === 1 ? parsed(only) : invalid(`${name} could name more than one option.`);
};

// The options under `ui`.

/** What every option under `ui` is named with first. */
export const uiPrefix = "ui.";

/**
 * Whether a name is under `ui`, so `resolveUi` reads it rather than `resolve`.
 * @param name - The name.
 * @returns Whether it is.
 */
export const isUiName = (name: string): boolean => name.startsWith(uiPrefix);

/** What a name under `ui` resolves to: the option, and its field. */
export interface ResolvedUi {
  readonly option: UiOptionName;
  readonly field: Field;
}

const decodeUiName = Schema.decodeUnknownOption(UiOptionName);

/**
 * The option a name under `ui` names, read from the Schema alone: `ui.<option>`.
 * @param name - The name.
 * @returns The option and its field, or why it names none.
 */
export const resolveUi = (name: string): Parsed<ResolvedUi> => {
  const key = isUiName(name) ? name.slice(uiPrefix.length) : "";
  const option = decodeUiName(key);
  const field = fieldNamed(uiFields, key);

  return Maybe.isSome(option) && field !== undefined
    ? parsed({ field, option: option.value })
    : invalid(`There is no option ${name}. ${optionsAreNamed}`);
};

/**
 * A `ui` option's name.
 * @param option - The option.
 * @returns Its dotted name, such as `ui.time`.
 */
export const uiOptionName = (option: UiOptionName): string => `${uiPrefix}${option}`;

/**
 * An option's value, from its text syntax, parsed first as its kind, then by its own
 * Schema, as the JSON the Daemon takes.
 * @param name - The option's dotted name, to say why not.
 * @param field - Its field, or none when there is no such option.
 * @param codec - Its Schema, as JSON.
 * @param text - The text.
 * @returns The value, or why the text is not one.
 */
const parseFieldText = (
  name: string,
  field: Field | undefined,
  codec: Schema.Codec<unknown, Json>,
  text: string
): Parsed<Json> => {
  if (field === undefined) {
    return invalid(`There is no option ${name}.`);
  }

  const json = parseText(field.kind, text);

  if (json._tag === "Invalid") {
    return invalid(`${name}: ${json.message}`);
  }

  // A key of a map of choices its Schema refuses, such as a Timeline's id that is none, is
  // refused, never dropped. Every other option drops what it does not know, as it always has.
  const value = Schema.decodeResult(codec)(json.value, {
    onExcessProperty: field.kind._tag === "ChoiceByKey" ? "error" : "ignore",
  });

  if (Result.isSuccess(value)) {
    return parsed(Schema.encodeUnknownSync(codec)(value.success));
  }

  // Text is taken as it is, so only the Schema's own checks refuse it, and they say why
  // without showing it back, as it may hold a control character.
  return field.kind._tag === "Text"
    ? invalid(`${name} ${value.failure.message}.`)
    : invalid(`${name} cannot be "${text.trim()}".`);
};

/**
 * A `ui` option's value, from its text syntax, parsed by its Schema, as the JSON the Daemon
 * takes and a device keeps.
 * @param option - The option.
 * @param text - The text.
 * @returns The value, or why the text is not one.
 */
export const parseUiText = (option: UiOptionName, text: string): Parsed<Json> =>
  parseFieldText(
    uiOptionName(option),
    fieldNamed(uiFields, option),
    Schema.toCodecJson(UiOptions.fields[option]),
    text
  );

/**
 * A `ui` option's value as JSON, as the Daemon takes it.
 * @param option - The option.
 * @param value - Its value.
 * @returns The JSON.
 */
const uiValueJson = (option: UiOptionName, value: UiOptions[UiOptionName]): Json =>
  Schema.encodeUnknownSync(Schema.toCodecJson(UiOptions.fields[option]))(value);

/** What the view says of a font's family this device was found to lack. */
export const fontMissing = "not found on this device";

/** A device that was found to lack no font's family. */
const noneMissing: ReadonlySet<FontFamily> = new Set();

/**
 * A `ui` option's value, shown in its text syntax.
 * @param field - Its field.
 * @param option - The option.
 * @param value - Its value, decoded.
 * @returns The value as the view shows it.
 */
const shownUi = (field: Field, option: UiOptionName, value: UiOptions[UiOptionName]): Value => ({
  _tag: "Shown",
  text: showText(field.kind, uiValueJson(option, value)),
});

/**
 * What the view says of a `ui` option's value in effect: that it is a font's family this
 * device was found to lack, or nothing.
 * @param option - The option.
 * @param value - Its value in effect, decoded.
 * @param missing - The fonts' families this device was found to lack.
 * @returns The note, or none.
 */
const noteOf = (
  option: UiOptionName,
  value: UiOptions[UiOptionName],
  missing: ReadonlySet<FontFamily>
): string | undefined => {
  const families: ReadonlySet<string> = missing;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a font is told apart from the other options' values by its type.
  return option === "font" && typeof value === "string" && families.has(value)
    ? fontMissing
    : undefined;
};

/**
 * Every option under `ui`, in the Schema's order, each with the value in effect on this
 * device, the shared one, and this device's override, and a font's family in effect that
 * this device was found to lack said to be not found.
 * @param shared - The shared options, once read.
 * @param device - This device's overrides.
 * @param missing - The fonts' families this device was found to lack, as far as it can
 *   tell, which only the device can find out.
 * @returns The options.
 */
export const uiOptionsOf = (
  shared: UiInForce | undefined,
  device: DeviceUi,
  missing: ReadonlySet<FontFamily> = noneMissing
): readonly UiOption[] => {
  const effective = effectiveUi(shared, device);

  return uiFields.flatMap((field) => {
    const option = decodeUiName(field.key);

    if (Maybe.isNone(option)) {
      return [];
    }

    const name = option.value;
    const own = overridesHeld(device)[name];

    return [
      {
        _tag: "Ui",
        description: field.description,
        device: own === undefined ? undefined : shownUi(field, name, own),
        kind: field.kind,
        name: uiOptionName(name),
        note: noteOf(name, effective[name], missing),
        option: name,
        shared:
          shared === undefined ? { _tag: "Unset" } : shownUi(field, name, shared.options[name]),
        starts: showText(field.kind, uiValueJson(name, uiDefaults[name])),
        unsettable: true,
        value: shownUi(field, name, effective[name]),
      },
    ];
  });
};

// The options under `store`, `uploads`, and `previews`.

/** The first segment of each option's name under `store`, `uploads`, and `previews`. */
const ownerRoots: ReadonlySet<string> = new Set(
  ownerOptionNames.map((name) => name.slice(0, name.indexOf(".")))
);

/**
 * Whether a name is under `store`, `uploads`, or `previews`, so `resolveOwner` reads it rather than
 * `resolve`.
 * @param name - The name.
 * @returns Whether it is.
 */
export const isOwnerName = (name: string): boolean =>
  name.includes(".") && ownerRoots.has(name.slice(0, name.indexOf(".")));

/** What a name under `store`, `uploads`, or `previews` resolves to: the option, and its field. */
export interface ResolvedOwner {
  readonly option: OwnerOptionName;
  readonly field: Field;
}

const decodeOwnerName = Schema.decodeUnknownOption(OwnerOptionName);

/**
 * The option a name under `store`, `uploads`, or `previews` names, read from the Schema alone: the
 * option's full name, such as `store.s3.bucket`.
 * @param name - The name.
 * @returns The option and its field, or why it names none.
 */
export const resolveOwner = (name: string): Parsed<ResolvedOwner> => {
  const option = decodeOwnerName(name);
  const field = fieldNamed(ownerFields, name);

  return Maybe.isSome(option) && field !== undefined
    ? parsed({ field, option: option.value })
    : invalid(`There is no option ${name}. ${optionsAreNamed}`);
};

/**
 * An option's value under `store`, `uploads`, or `previews`, from its text syntax, parsed by its
 * Schema, as the JSON the Daemon takes. A Credential option's value is never text.
 * @param option - The option.
 * @param text - The text.
 * @returns The value, or why the text is not one.
 */
export const parseOwnerText = (option: OwnerOptionName, text: string): Parsed<Json> =>
  parseFieldText(
    option,
    fieldNamed(ownerFields, option),
    Schema.toCodecJson(OwnerOptions.fields[option]),
    text
  );

/**
 * An option's value under `store`, `uploads`, or `previews` as JSON, as the Daemon takes it.
 * @param option - The option.
 * @param value - Its value.
 * @returns The JSON.
 */
const ownerValueJson = (option: OwnerOptionName, value: OwnerOptions[OwnerOptionName]): Json =>
  Schema.encodeUnknownSync(Schema.toCodecJson(OwnerOptions.fields[option]))(value);

/**
 * What the Credential option under `store`, `uploads`, or `previews` that names none starts naming:
 * `Owner.` and the option's name, such as `Owner.store.s3.accessKeyId`. No Network's
 * Credential is ever named so, as a Network's id, which each of theirs starts with, starts
 * with a lower-case letter or a digit.
 * @param option - The option.
 * @returns The name.
 */
export const derivedOwnerCredential = (option: OwnerOptionName): string => `Owner.${option}`;

/**
 * The Credential a Credential option under `store`, `uploads`, or `previews` names, or the one it
 * would name.
 * @param owner - The options in force.
 * @param option - The option.
 * @returns The name.
 */
export const ownerCredentialFor = (owner: OwnerOptions, option: OwnerOptionName): string =>
  textOf(owner[option]) ?? derivedOwnerCredential(option);

/**
 * Every option under `store`, `uploads`, and `previews`, in the Schema's order, each with its value in
 * force, or as being read before they are, never what it starts as, which would read as the
 * answer. A Credential option shows the Credential it names, and whether the Vault holds it,
 * never a value.
 * @param owner - The options in force, once read.
 * @param held - The Credentials the Vault holds, when known.
 * @returns The options.
 */
export const ownerOptionsOf = (
  owner: OwnerInForce | undefined,
  held: HeldNames
): readonly OwnerOption[] =>
  ownerFields.flatMap((field) => {
    const option = decodeOwnerName(field.key);

    if (Maybe.isNone(option)) {
      return [];
    }

    const name = option.value;
    const value = owner?.options[name];
    const json = value === undefined ? undefined : ownerValueJson(name, value);
    const credential = field.kind._tag === "Credential" ? textOf(json) : undefined;

    const shown = (): Value => {
      if (owner === undefined) {
        return { _tag: "Reading" };
      }

      if (json === undefined) {
        return { _tag: "Unset" };
      }

      return credential === undefined
        ? { _tag: "Shown", text: showText(field.kind, json) }
        : { _tag: "Credential", held: heldOf(held, credential), name: credential };
    };

    return [
      {
        _tag: "Owner",
        description: field.description,
        kind: field.kind,
        name,
        option: name,
        starts: field.starts._tag === "Value" ? showText(field.kind, field.starts.value) : "unset",
        unsettable: true,
        value: shown(),
      },
    ];
  });

// Reading by path.

/**
 * The value at a path, or none.
 * @param plain - The Configuration, as JSON.
 * @param path - The path.
 * @returns The value.
 */
const valueAt = (plain: Record, path: Path): Json | undefined => {
  const [key = "", second, third] = path;
  const top = plain[key];

  if (second === undefined) {
    return top;
  }

  if (third === undefined) {
    return isRecord(top) ? top[second] : undefined;
  }

  return records(top).find((one) => one.name === second)?.[third];
};

// Credential names.

const credentialPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const escaped = (character: string) =>
  [...new TextEncoder().encode(character)]
    .map((byte) => `_${byte.toString(16).padStart(2, "0")}`)
    .join("");

/**
 * The Credential name the core derives for a Credential option: its name below
 * `network.`, with every character a Credential's name cannot hold, `_` included, written
 * as `_` and its code in hex, so two options never derive one name.
 * @param network - The Network.
 * @param path - The option's path.
 * @returns The name, or why there is none, when it would be too long.
 */
export const derivedCredential = (network: string, path: Path): Parsed<string> => {
  const name = [network, ...path].join(".").replaceAll(/[^A-Za-z0-9.-]/gu, escaped);

  return credentialPattern.test(name)
    ? parsed(name)
    : invalid(
        `A Credential for ${optionName(network, path)} would be named ${name}, which is too long.`
      );
};

/**
 * The Credential a Credential option names in a Configuration, or the one it would name.
 * @param network - The Network.
 * @param configuration - Its Configuration.
 * @param path - The option's path.
 * @returns The name.
 */
export const credentialFor = (
  network: NetworkId,
  configuration: Configuration,
  path: Path
): Parsed<string> => {
  const named = textOf(valueAt(configuration, path));

  return named === undefined ? derivedCredential(network, path) : parsed(named);
};

// Editing.

/**
 * What a field starts with, as a value, for a Configuration whose first nick is given.
 * @param network - The Network.
 * @param field - The field.
 * @param path - Its path.
 * @param nick - The first nick.
 * @returns The value, none for an absent field, or why there is none.
 */
const startingValue = (
  network: string,
  field: Field,
  path: Path,
  nick: string | undefined
): Parsed<Json | undefined> => {
  const { starts } = field;

  switch (starts._tag) {
    case "Value": {
      return parsed(starts.value);
    }

    case "FirstNick": {
      return nick === undefined ? invalid("Set the nicks first.") : parsed(nick);
    }

    case "Named": {
      return derivedCredential(network, path);
    }

    case "Absent": {
      return parsed(undefined);
    }

    case "Given": {
      return invalid(`${optionName(network, path)} has no starting value, so it must be given.`);
    }

    default: {
      return starts satisfies never;
    }
  }
};

/**
 * A member of a tagged union with each field at what it starts with.
 * @param network - The Network.
 * @param key - The union's field.
 * @param member - The member.
 * @param nick - The first nick.
 * @returns The member's value, or why there is none.
 */
const startingMember = (
  network: string,
  key: string,
  member: Member,
  nick: string | undefined
): Parsed<Record> => {
  let value: Record = { _tag: member.tag };

  for (const field of member.fields) {
    const starting = startingValue(network, field, [key, field.key], nick);

    if (starting._tag === "Invalid") {
      return starting;
    }

    value = withKey(value, field.key, starting.value);
  }

  return parsed(value);
};

const decodeConfiguration = Schema.decodeUnknownExit(NetworkConfiguration);

/**
 * JSON parsed as a Configuration.
 * @param plain - The JSON.
 * @returns The Configuration, or why it is not one, in words.
 */
const configurationOf = (plain: Record): Parsed<Configuration> => {
  const decoded = decodeConfiguration(plain);

  return Exit.isSuccess(decoded)
    ? parsed(decoded.value)
    : invalid(`That would not be a valid Configuration. ${String(decoded.cause)}`);
};

const firstNick = (plain: Record): string | undefined => texts(plain.nicks)[0];

const noOption = (network: string, path: Path) =>
  invalid<Record>(`There is no option ${optionName(network, path)}.`);

/**
 * A value set at a path of a member's field. Members may share a field, such as an
 * account, which is the one in force when it has the field. A field of a member not in
 * force puts the first member with it in force first, with its fields at what they
 * start with.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param path - The path.
 * @param value - The value, or none to leave the field out.
 * @returns The JSON after, or why it cannot be.
 */
const setInMember = (
  network: string,
  plain: Record,
  path: readonly [string, string],
  value: Json | undefined
): Parsed<Record> => {
  const [key, second] = path;
  const top = fieldNamed(fields, key);
  const members = top?.kind._tag === "Tagged" ? top.kind.members : [];
  const current = plain[key];
  const having = members.filter((one) => fieldNamed(one.fields, second) !== undefined);

  const member = having.find((one) => isRecord(current) && current._tag === one.tag) ?? having[0];

  if (member === undefined) {
    return noOption(network, path);
  }

  const base =
    isRecord(current) && current._tag === member.tag
      ? parsed(current)
      : startingMember(network, key, member, firstNick(plain));

  return base._tag === "Invalid"
    ? base
    : parsed(withKey(plain, key, withKey(base.value, second, value)));
};

/**
 * A value set at a path, as JSON.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param path - The path.
 * @param value - The value, or none to leave the field out.
 * @returns The JSON after, or why it cannot be.
 */
const setAt = (
  network: string,
  plain: Record,
  path: Path,
  value: Json | undefined
): Parsed<Record> => {
  const [key = "", second, third] = path;

  if (second === undefined) {
    return parsed(withKey(plain, key, value));
  }

  if (third === undefined) {
    return setInMember(network, plain, [key, second], value);
  }

  const elements = records(plain[key]);

  if (!elements.some((one) => one.name === second)) {
    return invalid(`${second} is not among ${optionName(network, [key])}. Add it there first.`);
  }

  return parsed(
    withKey(
      plain,
      key,
      elements.map((one) => (one.name === second ? withKey(one, third, value) : one))
    )
  );
};

/**
 * Names set as a keyed list: each name kept with its other fields when it was there, and
 * new ones with none.
 * @param current - The list now.
 * @param names - The names wanted, in order.
 * @returns The list after.
 */
const named = (current: Json | undefined, names: readonly string[]): readonly Record[] => {
  const before = records(current);

  return [...new Set(names)].map((name) => before.find((one) => one.name === name) ?? { name });
};

/** What the Daemon reports of a Network that bears on the names of its Channels. */
export interface Naming {
  /** How the Network folds names, as an Ircd declared it, or none while none has. */
  readonly casemapping: Casemapping | undefined;
  /** `CHANTYPES`, what a Channel's name starts with, while a Session has said. */
  readonly chantypes: string | undefined;
}

/** A Network the Daemon has said nothing of yet. */
export const unknownNaming: Naming = { casemapping: undefined, chantypes: undefined };

/** The Channel prefixes RFC 2811 names, recognised while a Network's `CHANTYPES` is unknown. */
const rfcPrefixes = "#&+!";

/**
 * A Channel's name, as `/join` and `/part` take it: one that starts with a `CHANTYPES`
 * character is kept exactly. With `CHANTYPES` known, a bare name gets its first character.
 * Without it, a name with no prefix RFC 2811 names is refused, never guessed at.
 * @param network - The Network.
 * @param text - The name as given.
 * @param naming - What the Daemon reports of the Network.
 * @returns The name, or why not.
 */
const channelOf = (network: string, text: string, naming: Naming): Parsed<string> => {
  const leading = text.codePointAt(0);
  const first = leading === undefined ? "" : String.fromCodePoint(leading);
  const { chantypes } = naming;

  if (chantypes === undefined) {
    return rfcPrefixes.includes(first) && first !== ""
      ? parsed(text)
      : invalid(
          `${network} has not said what its Channels start with, so give ${text} with its prefix, such as #${text}.`
        );
  }

  if (chantypes.includes(first) && first !== "") {
    return parsed(text);
  }

  const code = chantypes.codePointAt(0);
  const prefix = code === undefined ? undefined : String.fromCodePoint(code);

  return prefix === undefined
    ? invalid(`${network} says it has no Channels.`)
    : parsed(`${prefix}${text}`);
};

/**
 * The Channels a list names, as `/join` and `/part` take them: comma-separated, since no
 * Channel's name holds a comma, each as given, its prefix settled when it is applied.
 * @param text - The text.
 * @returns The names, or why not.
 */
export const channelsOf = (text: string): Parsed<readonly string[]> => {
  const names = text
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");

  // oxlint-disable-next-line no-control-regex -- a Channel's name may hold no control.
  const bad = names.find((name) => /[\s\u0000-\u001F\u007F]/u.test(name));

  if (bad !== undefined) {
    return invalid(`"${bad}" is not a Channel's name.`);
  }

  return names.length === 0 ? invalid("Name a Channel, such as #iirc.") : parsed(names);
};

/**
 * How names are compared on a Network: folded by the casemapping the Daemon reports, or
 * exactly while it reports none.
 * @param naming - What the Daemon reports of the Network.
 * @returns The fold.
 */
const foldBy =
  (naming: Naming) =>
  (name: string): string =>
    naming.casemapping === undefined ? name : casefold(naming.casemapping, name);

const nameOf = (entry: Record): string => textOf(entry.name) ?? "";

/**
 * The one entry a name parts: the one named exactly, else the one it folds to. Two or more
 * that fold together are refused, by name, so no more than one is ever parted.
 * @param network - The Network.
 * @param entries - The Channels wanted.
 * @param name - The name given.
 * @param fold - How names are compared.
 * @returns The entry, or why none.
 */
const entryFor = (
  network: string,
  entries: readonly Record[],
  name: string,
  fold: (name: string) => string
): Parsed<Record> => {
  const exact = entries.find((entry) => nameOf(entry) === name);
  const folded = entries.filter((entry) => fold(nameOf(entry)) === fold(name));
  const [only] = folded;

  if (exact !== undefined) {
    return parsed(exact);
  }

  if (only === undefined) {
    return invalid(`${name} is not among the Channels of ${network}.`);
  }

  return folded.length === 1
    ? parsed(only)
    : invalid(
        `${name} could be any of ${folded.map(nameOf).join(", ")} on ${network}. Part one by its exact name.`
      );
};

/**
 * Whether a Channel is among those wanted in a Configuration, compared as `/part` compares
 * them: folded by the casemapping the Daemon reports, or exactly while it reports none.
 * @param configuration - The Configuration.
 * @param channel - The Channel's name, as the Daemon has it.
 * @param naming - What the Daemon reports of the Network.
 * @returns Whether it is wanted.
 */
export const wantsChannel = (
  configuration: Configuration,
  channel: string,
  naming: Naming
): boolean => {
  const fold = foldBy(naming);

  return records(configuration.channels).some((entry) => fold(nameOf(entry)) === fold(channel));
};

/**
 * An option set from its text.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param path - The option's path.
 * @param text - The value, in its text syntax.
 * @returns The JSON after, or why not.
 */
const setText = (network: string, plain: Record, path: Path, text: string): Parsed<Record> => {
  const at = resolvePath(path.join("."));
  const [key = ""] = path;

  if (at === undefined) {
    return noOption(network, path);
  }

  const { kind } = at.field;
  const value = parseText(kind, text);

  if (value._tag === "Invalid") {
    return invalid(`${optionName(network, path)}: ${value.message}`);
  }

  if (kind._tag === "Names") {
    return setAt(network, plain, path, named(plain[key], texts(value.value)));
  }

  if (kind._tag !== "Tagged") {
    return setAt(network, plain, path, value.value);
  }

  const member = kind.members.find((one) => one.tag === value.value);
  const current = plain[key];

  if (member === undefined || (isRecord(current) && current._tag === member.tag)) {
    return parsed(plain);
  }

  const started = startingMember(network, key, member, firstNick(plain));

  return started._tag === "Invalid" ? started : setAt(network, plain, path, started.value);
};

/**
 * An option returned to what a new Network starts with, or left out when optional. A
 * field of a member not in force has nothing to unset.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param path - The option's path.
 * @returns The JSON after, or why not.
 */
const unsetAt = (network: string, plain: Record, path: Path): Parsed<Record> => {
  const at = resolvePath(path.join("."));
  const [key = "", second, third] = path;
  const current = plain[key];

  if (at === undefined) {
    return noOption(network, path);
  }

  if (second !== undefined && third === undefined && isRecord(current) && !(second in current)) {
    return parsed(plain);
  }

  // A member's Credential is what it logs in with: unsetting it would only point it at
  // another, so it is refused, saying how to put the union back as a new Network starts.
  if (third === undefined && second !== undefined && at.field.kind._tag === "Credential") {
    const union = fieldNamed(fields, key);
    const off = union?.starts._tag === "Value" ? showText(union.kind, union.starts.value) : "none";

    return invalid(
      `${optionName(network, path)} is the Credential ${key} uses, so it cannot be unset. /set ${optionName(network, [key])} ${off} turns ${key} off.`
    );
  }

  const starting = startingValue(network, at.field, path, firstNick(plain));

  return starting._tag === "Invalid" ? starting : setAt(network, plain, path, starting.value);
};

/**
 * Channels added to those wanted, unless one is already wanted by a name the Network
 * folds it to, or exactly while its casemapping is unknown.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param channels - The Channels, as given.
 * @param naming - What the Daemon reports of the Network.
 * @returns The JSON after, or why not.
 */
const joined = (
  network: string,
  plain: Record,
  channels: readonly string[],
  naming: Naming
): Parsed<Record> => {
  const fold = foldBy(naming);
  const current = records(plain.channels);
  const wanted = new Set(current.map((entry) => fold(nameOf(entry))));
  const added: Record[] = [];

  for (const given of channels) {
    const name = channelOf(network, given, naming);

    if (name._tag === "Invalid") {
      return name;
    }

    if (!wanted.has(fold(name.value))) {
      wanted.add(fold(name.value));
      added.push({ name: name.value });
    }
  }

  return parsed(withKey(plain, "channels", [...current, ...added]));
};

/**
 * Channels taken from those wanted, one entry for each name given, as `entryFor` finds it.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param channels - The Channels, as given.
 * @param naming - What the Daemon reports of the Network.
 * @returns The JSON after, or why not.
 */
const parted = (
  network: string,
  plain: Record,
  channels: readonly string[],
  naming: Naming
): Parsed<Record> => {
  const fold = foldBy(naming);
  let current = records(plain.channels);

  for (const given of channels) {
    const name = channelOf(network, given, naming);
    const entry = name._tag === "Invalid" ? name : entryFor(network, current, name.value, fold);

    if (entry._tag === "Invalid") {
      return entry;
    }

    current = current.filter((one) => one !== entry.value);
  }

  return parsed(withKey(plain, "channels", current));
};

/**
 * The Channel a Timeline was routed to, taken from those wanted: its key, as the Daemon
 * folded it, against each wanted name folded the same way, by the casemapping the Network
 * declared, or `rfc1459` while none has, as the Daemon folds keys.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param timeline - The Timeline's key and name.
 * @param naming - What the Daemon reports of the Network.
 * @returns The JSON after, or why not.
 */
const partedTimeline = (
  network: string,
  plain: Record,
  timeline: { readonly key: string; readonly name: string },
  naming: Naming
): Parsed<Record> => {
  const casemapping = naming.casemapping ?? defaultCasemapping;
  const current = records(plain.channels);
  const routed = current.filter((entry) => casefold(casemapping, nameOf(entry)) === timeline.key);
  const entry = entryFor(network, routed, timeline.name, (name) => casefold(casemapping, name));

  return entry._tag === "Invalid"
    ? entry
    : parsed(
        withKey(
          plain,
          "channels",
          current.filter((one) => one !== entry.value)
        )
      );
};

/**
 * How masks are compared on a Network: folded by the casemapping it declared, or `rfc1459`
 * while none has, as the Client folds them.
 * @param naming - What the Daemon reports of the Network.
 * @returns The fold.
 */
const maskFold =
  (naming: Naming) =>
  (mask: string): string =>
    casefold(naming.casemapping ?? defaultCasemapping, mask);

/**
 * A mask added to those ignored, unless one the Network folds it to already is.
 * @param plain - The Configuration, as JSON.
 * @param mask - The mask.
 * @param naming - What the Daemon reports of the Network.
 * @returns The JSON after.
 */
const ignored = (plain: Record, mask: IgnoreMask, naming: Naming): Record => {
  const fold = maskFold(naming);
  const current = texts(plain.ignores);

  return current.some((one) => fold(one) === fold(mask))
    ? plain
    : withKey(plain, "ignores", [...current, mask]);
};

/**
 * Every mask ignored that the Network folds a mask to, taken out, since each hides the
 * same Users.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param mask - The mask.
 * @param naming - What the Daemon reports of the Network.
 * @returns The JSON after, or why not.
 */
const unignored = (
  network: string,
  plain: Record,
  mask: IgnoreMask,
  naming: Naming
): Parsed<Record> => {
  const fold = maskFold(naming);
  const current = texts(plain.ignores);
  const kept = current.filter((one) => fold(one) !== fold(mask));

  return kept.length === current.length
    ? invalid(`${mask} is not among ${optionName(network, ["ignores"])}.`)
    : parsed(withKey(plain, "ignores", kept));
};

/**
 * The JSON an edit leaves, before it is parsed again.
 * @param network - The Network.
 * @param plain - The Configuration, as JSON.
 * @param edit - The edit.
 * @param naming - What the Daemon reports of the Network.
 * @returns The JSON after, or why the edit cannot be made.
 */
const edited = (network: string, plain: Record, edit: Edit, naming: Naming): Parsed<Record> => {
  switch (edit._tag) {
    case "Set": {
      return setText(network, plain, edit.path, edit.text);
    }

    case "Unset": {
      return unsetAt(network, plain, edit.path);
    }

    case "Point": {
      return resolvePath(edit.path.join("."))?.field.kind._tag === "Credential"
        ? setAt(network, plain, edit.path, edit.credential)
        : invalid(`${optionName(network, edit.path)} is not a Credential.`);
    }

    case "Join": {
      return joined(network, plain, edit.channels, naming);
    }

    case "Part": {
      return parted(network, plain, edit.channels, naming);
    }

    case "PartTimeline": {
      return partedTimeline(network, plain, edit, naming);
    }

    case "Ignore": {
      return parsed(ignored(plain, edit.mask, naming));
    }

    case "Unignore": {
      return unignored(network, plain, edit.mask, naming);
    }

    default: {
      return edit satisfies never;
    }
  }
};

/**
 * An edit applied to a Network's Configuration, giving the whole Configuration after,
 * parsed again by its Schema, so what it gives is always a Configuration.
 * @param network - The Network.
 * @param configuration - Its Configuration in force.
 * @param edit - The edit.
 * @param naming - What the Daemon reports of the Network, which `Join` and `Part` compare
 * Channels' names by, and `Ignore` and `Unignore` masks.
 * @returns The Configuration after, or why the edit cannot be made, in words.
 */
export const apply = (
  network: NetworkId,
  configuration: Configuration,
  edit: Edit,
  naming: Naming = unknownNaming
): Parsed<Configuration> => {
  const after = edited(network, configuration, edit, naming);

  return after._tag === "Invalid" ? after : configurationOf(after.value);
};

/**
 * A Network's option set to a value in its text syntax.
 * @param network - The Network.
 * @param configuration - Its Configuration.
 * @param path - The option's path.
 * @param text - The value.
 * @returns The Configuration after, or why not.
 */
export const set = (
  network: NetworkId,
  configuration: Configuration,
  path: Path,
  text: string
): Parsed<Configuration> => apply(network, configuration, { _tag: "Set", path, text });

/**
 * A Network's option returned to what a new Network starts with.
 * @param network - The Network.
 * @param configuration - Its Configuration.
 * @param path - The option's path.
 * @returns The Configuration after, or why not.
 */
export const unset = (
  network: NetworkId,
  configuration: Configuration,
  path: Path
): Parsed<Configuration> => apply(network, configuration, { _tag: "Unset", path });

/**
 * The Configuration a new Network starts with: every field at what it starts with, and
 * those that must be given, given.
 * @param network - The Network.
 * @param given - The fields given, such as its Ircds and nicks.
 * @returns The Configuration, or why it cannot be made.
 */
export const starting = (network: NetworkId, given: Record): Parsed<Configuration> => {
  let plain: Record = {};
  const nick = firstNick(given);

  for (const field of fields) {
    const value =
      field.key in given
        ? parsed(given[field.key])
        : startingValue(network, field, [field.key], nick);

    if (value._tag === "Invalid") {
      return value;
    }

    plain = withKey(plain, field.key, value.value);
  }

  return configurationOf(plain);
};

// Listing.

/**
 * What a field starts with, in words or in its text syntax.
 * @param network - The Network.
 * @param field - The field.
 * @param path - Its path.
 * @returns The words, or none when it must be given.
 */
const startsText = (network: string, field: Field, path: Path): string | undefined => {
  const { starts } = field;

  switch (starts._tag) {
    case "Value": {
      return showText(field.kind, starts.value);
    }

    case "FirstNick": {
      return "the first nick";
    }

    case "Named": {
      const name = derivedCredential(network, path);

      return name._tag === "Parsed" ? name.value : undefined;
    }

    case "Absent": {
      return "unset";
    }

    case "Given": {
      return undefined;
    }

    default: {
      return starts satisfies never;
    }
  }
};

/**
 * One option of a field.
 * @param network - The Network.
 * @param field - The field.
 * @param path - Its path.
 * @param value - Its value, or none.
 * @param held - The Credentials the Vault holds, when known.
 * @returns The option.
 */
const optionOf = (
  network: NetworkId,
  field: Field,
  path: Path,
  value: Json | undefined,
  held: HeldNames
): NetworkOption => {
  const credential = field.kind._tag === "Credential" ? textOf(value) : undefined;

  const shown = (): Value => {
    if (value === undefined) {
      return { _tag: "Unset" };
    }

    return credential === undefined
      ? { _tag: "Shown", text: showText(field.kind, value) }
      : { _tag: "Credential", held: heldOf(held, credential), name: credential };
  };

  return {
    _tag: "Network",
    description: field.description,
    kind: field.kind,
    name: optionName(network, path),
    network,
    path,
    starts: startsText(network, field, path),
    unsettable: field.starts._tag !== "Given",
    value: shown(),
  };
};

/**
 * The options of a union's members, each field once, in the order the members first name
 * them. A field members share, such as an account, is the in-force member's, holding its
 * value, and any other field shows as unset.
 * @param network - The Network.
 * @param key - The union's field.
 * @param members - Its members.
 * @param value - The member in force.
 * @param held - The Credentials the Vault holds, when known.
 * @returns The options.
 */
const memberOptions = (
  network: NetworkId,
  key: string,
  members: readonly Member[],
  value: Json | undefined,
  held: HeldNames
): readonly NetworkOption[] => {
  const inForce = isRecord(value) ? value : undefined;
  const own = members.find((member) => member.tag === inForce?._tag);
  const keys = [...new Set(members.flatMap((member) => member.fields.map((sub) => sub.key)))];

  return keys.flatMap((subKey) => {
    const mine = own === undefined ? undefined : fieldNamed(own.fields, subKey);

    const sub =
      mine ?? members.flatMap((member) => member.fields).find((field) => field.key === subKey);

    return sub === undefined
      ? []
      : [
          optionOf(
            network,
            sub,
            [key, subKey],
            mine === undefined ? undefined : inForce?.[subKey],
            held
          ),
        ];
  });
};

/**
 * Every option of a Network's Configuration, in the Schema's order: each field, each
 * member's fields under a tagged union, and each record's fields under its name.
 * @param network - The Network.
 * @param configuration - Its Configuration.
 * @param held - The Credentials the Vault holds, when known.
 * @returns The options.
 */
export const optionsOf = (
  network: NetworkId,
  configuration: Configuration,
  held: HeldNames
): readonly NetworkOption[] => {
  const plain: Record = configuration;

  return fields.flatMap((field) => {
    const value = plain[field.key];
    const own = optionOf(network, field, [field.key], value, held);
    const { kind } = field;

    if (kind._tag === "Tagged") {
      return [own, ...memberOptions(network, field.key, kind.members, value, held)];
    }

    if (kind._tag === "Names") {
      return [
        own,
        ...records(value).flatMap((element) =>
          kind.fields.map((sub) =>
            optionOf(
              network,
              sub,
              [field.key, textOf(element.name) ?? "", sub.key],
              element[sub.key],
              held
            )
          )
        ),
      ];
    }

    return [own];
  });
};

/**
 * Whether an option's name matches what the Owner typed: with a `*`, as a pattern where
 * `*` stands for any text, such as `network.libera.*` or `*nick*`, and otherwise as text
 * found anywhere in it, in any ASCII case.
 * @param filter - What was typed.
 * @param name - The option's name.
 * @returns Whether it matches.
 */
export const matches = (filter: string, name: string): boolean => {
  const wanted = lower(filter.trim());
  const subject = lower(name);

  if (!wanted.includes("*")) {
    return subject.includes(wanted);
  }

  const [first = "", ...rest] = wanted.split("*");
  const last = rest.pop() ?? "";

  if (!subject.startsWith(first)) {
    return false;
  }

  let at = first.length;

  for (const part of rest) {
    const found = subject.indexOf(part, at);

    if (found === -1) {
      return false;
    }

    at = found + part.length;
  }

  return subject.length - last.length >= at && subject.endsWith(last);
};

// The options view.

/**
 * A Network's Configuration as the options view read it.
 *
 * - `Reading`: asked for, with no answer yet.
 * - `Read`: the Configuration in force, and the sequence of the `Configured` that set it.
 * - `Failed`: the read failed, in words.
 */
export type Reading =
  | { readonly _tag: "Reading" }
  | { readonly _tag: "Read"; readonly configuration: Configuration; readonly sequence: number }
  | { readonly _tag: "Failed"; readonly message: string };

/**
 * The options view: what it read, and what the Owner is doing in it. Whether it is shown,
 * and its filter, are the main view's, in the Timelines' navigation, so they are never kept
 * in step with anything.
 */
export interface Options {
  /** Each Network's Configuration, by id, in the order the Networks were listed, once they are. */
  readonly networks: ReadonlyMap<NetworkId, Reading> | undefined;
  /** The options under `ui` every device shares, as last read or followed, once they are. */
  readonly ui: UiInForce | undefined;
  /** The options under `store`, `uploads`, and `previews`, as last read or followed, once they are. */
  readonly owner: OwnerInForce | undefined;
  /** The names of the Credentials the Vault holds, as far as is known. */
  readonly held: HeldNames;
  /** What the last edit from the view came to, when it did not go as asked, in words. */
  readonly notice: string | undefined;
  /** How many changes were asked for, which numbers each as it is asked. */
  readonly asked: number;
  /**
   * The changes asked for that the Daemon has not yet answered, oldest first. They are what
   * was asked and never a copy of the options, which `uiShown`, `ownerShown`, and
   * `configurationShown` derive from what is in force and these.
   */
  readonly onItsWay: readonly OnItsWay[];
  /** The option being edited in place, by name. */
  readonly editing: string | undefined;
  /** The option the Owner is asked to confirm unsetting, by name. */
  readonly confirming: string | undefined;
  /** The Credential option whose value a password prompt asks for, wherever it was asked. */
  readonly prompting: Prompt | undefined;
}

/**
 * A change the Owner asked for: one option under `ui`, or under `store`, `uploads`, or
 * `previews`, set to a value as JSON, or none to unset it, or an edit of a Network's Configuration.
 */
export type Wanted =
  | { readonly _tag: "Ui"; readonly option: UiOptionName; readonly value: Json | undefined }
  | { readonly _tag: "Owner"; readonly option: OwnerOptionName; readonly value: Json | undefined }
  | { readonly _tag: "Network"; readonly network: NetworkId; readonly edit: Edit };

/** A change asked for and not yet answered, with the number it was asked under. */
export type OnItsWay = Wanted & { readonly id: number };

/**
 * A Credential option whose value is asked for: a Network's, by its Network and path, or
 * one under `store`, `uploads`, or `previews`, by its name.
 */
export type Asked =
  | { readonly network: NetworkId; readonly path: Path }
  | { readonly option: OwnerOptionName };

/** A Credential option whose value is asked for, and its dotted name. */
export type Prompt = Asked & {
  /** Its dotted name. */
  readonly name: string;
};

/**
 * What happened to the options view.
 *
 * - `Listed`: the Networks to read, as `GET /api/networks` listed them.
 * - `Read`, `ReadFailed`: a Network's Configuration was read, or could not be.
 * - `UiRead`: the options under `ui` were read, or followed.
 * - `UiForgotten`: the page signed out, so the shared `ui` options it held may no longer
 *   be the ones in force, and are read again once it signs in. Changes of them on their way are let go.
 * - `OwnerRead`, `OwnerForgotten`: the same, for the options under `store`, `uploads`, and `previews`.
 * - `Asked`: the Owner asked for a change, which is on its way, and shows at once.
 * - `Answered`: the Daemon answered a change asked for, however it came out, so it is no longer
 *   on its way and what is in force shows.
 * - `Held`, `HeldFailed`: the names of the Credentials the Vault holds, or they could not be
 *   read, which leaves the names last read, if any.
 * - `Noticed`: what an edit came to, or nothing to let go of the last.
 * - `Editing`: an option is edited in place, or none is.
 * - `Confirming`: the Owner is asked to confirm unsetting an option, or is not.
 * - `Prompting`: a password prompt asks for a Credential option's value, or none does.
 */
export type OptionsEvent =
  | { readonly _tag: "Listed"; readonly networks: readonly NetworkId[] }
  | {
      readonly _tag: "Read";
      readonly network: NetworkId;
      readonly configuration: Configuration;
      readonly sequence: number;
    }
  | { readonly _tag: "ReadFailed"; readonly network: NetworkId; readonly message: string }
  | { readonly _tag: "UiRead"; readonly ui: UiInForce }
  | { readonly _tag: "UiForgotten" }
  | { readonly _tag: "OwnerRead"; readonly owner: OwnerInForce }
  | { readonly _tag: "OwnerForgotten" }
  | { readonly _tag: "Asked"; readonly change: Wanted }
  | { readonly _tag: "Answered"; readonly id: number }
  | { readonly _tag: "Held"; readonly names: readonly string[] }
  | { readonly _tag: "HeldFailed" }
  | { readonly _tag: "Noticed"; readonly message: string | undefined }
  | { readonly _tag: "Editing"; readonly name: string | undefined }
  | { readonly _tag: "Confirming"; readonly name: string | undefined }
  | { readonly _tag: "Prompting"; readonly prompt: Asked | undefined };

/** The options view before anything was read. */
export const initialOptions: Options = {
  asked: 0,
  confirming: undefined,
  editing: undefined,
  held: undefined,
  networks: undefined,
  notice: undefined,
  onItsWay: [],
  owner: undefined,
  prompting: undefined,
  ui: undefined,
};

/**
 * The newer of the options held and those just read, so an older read that lands late
 * never replaces a newer one.
 * @param held - The options held, once read.
 * @param read - The options just read.
 * @returns The newer.
 */
const newest = <A extends { readonly sequence: number }>(held: A | undefined, read: A): A =>
  held !== undefined && held.sequence > read.sequence ? held : read;

/**
 * The dotted name of a Credential option asked for.
 * @param asked - The option.
 * @returns Its name.
 */
const askedName = (asked: Asked): string =>
  "option" in asked ? asked.option : optionName(asked.network, asked.path);

/**
 * The view with a Network's read in. Before the Networks are listed, a read is let go of,
 * as listing them reads each again.
 * @param state - The view.
 * @param network - The Network.
 * @param reading - What its read came to.
 * @returns The view after.
 */
const readInto = (state: Options, network: NetworkId, reading: Reading): Options =>
  state.networks === undefined
    ? state
    : { ...state, networks: new Map(state.networks).set(network, reading) };

/**
 * The view with the Networks listed, each keeping what was read of it, and each new one
 * being read.
 * @param state - The view.
 * @param networks - The Networks, in the order listed.
 * @returns The view after.
 */
const listedInto = (state: Options, networks: readonly NetworkId[]): Options => ({
  ...state,
  networks: new Map(
    networks.map((network) => [network, state.networks?.get(network) ?? { _tag: "Reading" }])
  ),
});

/**
 * The view with a Network's Configuration read in, where an older read that lands late
 * never replaces a newer one.
 * @param state - The view.
 * @param read - The read.
 * @returns The view after.
 */
const configurationRead = (
  state: Options,
  read: Extract<OptionsEvent, { readonly _tag: "Read" }>
): Options => {
  const before = state.networks?.get(read.network);

  return before?._tag === "Read" && before.sequence > read.sequence
    ? state
    : readInto(state, read.network, {
        _tag: "Read",
        configuration: read.configuration,
        sequence: read.sequence,
      });
};

/**
 * The names held once a read of them failed: those last read, or not known.
 * @param held - The names held before.
 * @returns The names held after.
 */
const heldFailed = (held: HeldNames): HeldNames => held ?? "NotKnown";

/**
 * The options view after an event.
 * @param state - The view before.
 * @param event - What happened.
 * @returns The view after.
 */
export const reduceOptions = (state: Options, event: OptionsEvent): Options => {
  switch (event._tag) {
    case "Listed": {
      return listedInto(state, event.networks);
    }

    case "Read": {
      return configurationRead(state, event);
    }

    case "ReadFailed": {
      return readInto(state, event.network, { _tag: "Failed", message: event.message });
    }

    case "UiRead": {
      return { ...state, ui: newest(state.ui, event.ui) };
    }

    case "UiForgotten": {
      return {
        ...state,
        onItsWay: state.onItsWay.filter((way) => way._tag !== "Ui"),
        ui: undefined,
      };
    }

    case "OwnerRead": {
      return { ...state, owner: newest(state.owner, event.owner) };
    }

    case "OwnerForgotten": {
      return {
        ...state,
        onItsWay: state.onItsWay.filter((way) => way._tag !== "Owner"),
        owner: undefined,
      };
    }

    case "Asked": {
      return {
        ...state,
        asked: state.asked + 1,
        onItsWay: [...state.onItsWay, { ...event.change, id: state.asked }],
      };
    }

    case "Answered": {
      return { ...state, onItsWay: state.onItsWay.filter((way) => way.id !== event.id) };
    }

    case "Held": {
      return { ...state, held: new Set(event.names) };
    }

    case "HeldFailed": {
      return { ...state, held: heldFailed(state.held) };
    }

    case "Noticed": {
      return { ...state, notice: event.message };
    }

    // Editing one option, or asking to unset one, lets go of the other.
    case "Editing": {
      return { ...state, confirming: undefined, editing: event.name };
    }

    case "Confirming": {
      return { ...state, confirming: event.name, editing: undefined };
    }

    case "Prompting": {
      const { prompt } = event;

      return {
        ...state,
        editing: undefined,
        notice: undefined,
        prompting: prompt === undefined ? undefined : { ...prompt, name: askedName(prompt) },
      };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The shared options under `ui` as they show: those in force, each change of one on its way
 * applied over them in the order asked, where unsetting one is its default. Nothing is
 * applied while those in force are not known, since a default drawn then would read as the answer.
 * @param state - The view.
 * @returns The options as shown, with the sequence of those in force, or none while not known.
 */
export const uiShown = (state: Options): UiInForce | undefined => {
  const { ui } = state;

  if (ui === undefined) {
    return undefined;
  }

  let options: UiOptions = ui.options;

  for (const way of state.onItsWay) {
    if (way._tag === "Ui") {
      const value =
        way.value === undefined ? uiDefaults[way.option] : uiValueKept(way.option, way.value);

      options = value === undefined ? options : { ...options, [way.option]: value };
    }
  }

  return { options, sequence: ui.sequence };
};

/**
 * The options under `store`, `uploads`, and `previews` as they show, as `uiShown` shows
 * those under `ui`, where unsetting one is its default, or none when it has none.
 * @param state - The view.
 * @returns The options as shown, with the sequence of those in force, or none while not known.
 */
export const ownerShown = (state: Options): OwnerInForce | undefined => {
  const { owner } = state;

  if (owner === undefined) {
    return undefined;
  }

  const options: OwnerOptions = { ...owner.options };

  for (const way of state.onItsWay) {
    // A value its Schema refuses is left out, as `uiShown` leaves one out.
    const kept =
      way._tag !== "Owner" || way.value === undefined
        ? undefined
        : ownerValueKept(way.option, way.value);

    if (way._tag === "Owner" && (way.value === undefined || kept !== undefined)) {
      Object.assign(options, {
        [way.option]: way.value === undefined ? ownerDefaults[way.option] : kept,
      });
    }
  }

  return { options, sequence: owner.sequence };
};

/**
 * A Network's Configuration as it shows: the one read, each edit of it on its way applied
 * over it in the order asked, an edit that cannot be made left out. Nothing is applied until
 * it is read.
 * @param state - The view.
 * @param network - The Network.
 * @returns The Configuration as shown, or none while it is not read.
 */
export const configurationShown = (
  state: Options,
  network: NetworkId
): Configuration | undefined => {
  const reading = state.networks?.get(network);

  if (reading?._tag !== "Read") {
    return undefined;
  }

  let shown = reading.configuration;

  for (const way of state.onItsWay) {
    if (way._tag === "Network" && way.network === network) {
      const after = apply(network, shown, way.edit);

      shown = after._tag === "Invalid" ? shown : after.value;
    }
  }

  return shown;
};

/**
 * The options the view lists, that the filter matches: every option under `store` and
 * `uploads`, the Daemon's own, then every option of every Network read, then every option
 * under `ui`, as it takes effect on this device, each as it shows with the changes on its way.
 * @param state - The view.
 * @param filter - What the Owner typed to filter them.
 * @param device - This device's overrides of the options under `ui`.
 * @param missing - The fonts' families this device was found to lack.
 * @returns The options under `store`, `uploads`, and `previews`, then by Network in the order listed,
 *   then those under `ui`.
 */
export const listed = (
  state: Options,
  filter: string,
  device: DeviceUi = noOverrides,
  missing: ReadonlySet<FontFamily> = noneMissing
): readonly Option[] =>
  [
    ...ownerOptionsOf(ownerShown(state), state.held),
    ...[...(state.networks?.keys() ?? [])].flatMap((network) => {
      const configuration = configurationShown(state, network);

      return configuration === undefined ? [] : optionsOf(network, configuration, state.held);
    }),
    ...uiOptionsOf(uiShown(state), device, missing),
  ].filter((option) => matches(filter, option.name));

/**
 * The Networks whose options the view is still reading, by the names their options fall
 * under, such as `network.libera.*`: every Network, as `network.*`, before they are listed,
 * then each listed and not yet read. They draw as a wait, since leaving them out would read
 * as the answer that there are none.
 * @param state - The view.
 * @returns The names, none once every Network is read or failed.
 */
export const networksReading = (state: Options): readonly string[] =>
  state.networks === undefined
    ? ["network.*"]
    : [...state.networks].flatMap(([network, reading]) =>
        reading._tag === "Reading" ? [optionName(network, ["*"])] : []
      );
