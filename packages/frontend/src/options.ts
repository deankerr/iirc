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
 * them, and a device may override any of them for itself, which it never sends.
 *
 * @packageDocumentation
 */
import type { NetworkId } from "@iirc/api";
import { UiOptionName, UiOptions, uiDefaults } from "@iirc/api/ui";
import type { UiInForce } from "@iirc/api/ui";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import type { Casemapping } from "@iirc/protocol/casemapping";
import { Exit, Option as Maybe, Schema, SchemaAST } from "effect";

import type { Parsed } from "./commands.ts";
import { effectiveUi, noOverrides } from "./ui.ts";
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
 * - `Credential`: the name of a Credential, set by giving its value, which the Vault holds.
 * - `Texts`: a list, comma-separated, as WeeChat's are, never empty when `nonEmpty`.
 * - `Ircds`: Ircds, comma-separated, each `host/port`, TLS unless followed by the word
 *   `plain`. A port left out is 6697 with TLS and 6667 without.
 * - `Names`: a list of records keyed by their `name`, such as Channels, comma-separated by
 *   name. Each record's other fields are options of their own under its name.
 * - `Tagged`: one of `members`, by its tag in lower case, such as `none` or `sasl`. Each
 *   member's fields are options of their own under the option's name.
 */
export type Kind =
  | { readonly _tag: "Toggle" }
  | { readonly _tag: "Text" }
  | { readonly _tag: "Choice"; readonly choices: readonly string[] }
  | { readonly _tag: "Credential" }
  | { readonly _tag: "Texts"; readonly nonEmpty: boolean }
  | { readonly _tag: "Ircds" }
  | { readonly _tag: "Names"; readonly fields: readonly Field[] }
  | { readonly _tag: "Tagged"; readonly members: readonly Member[] };

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
 * - `Credential`: the Credential it names, and whether the Vault holds it, when known.
 */
export type Value =
  | { readonly _tag: "Shown"; readonly text: string }
  | { readonly _tag: "Unset" }
  | { readonly _tag: "Credential"; readonly name: string; readonly held: boolean | undefined };

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
  /** What it starts as, in its text syntax. */
  readonly starts: string | undefined;
  /** Whether `/unset` can return it to what it starts as, which every `ui` option can. */
  readonly unsettable: boolean;
}

/** One option, as the options view lists it. */
export type Option = NetworkOption | UiOption;

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
 */
export type Edit =
  | { readonly _tag: "Set"; readonly path: Path; readonly text: string }
  | { readonly _tag: "Unset"; readonly path: Path }
  | { readonly _tag: "Point"; readonly path: Path; readonly credential: string }
  | { readonly _tag: "Join"; readonly channels: readonly string[] }
  | { readonly _tag: "Part"; readonly channels: readonly string[] }
  | { readonly _tag: "PartTimeline"; readonly key: string; readonly name: string };

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

  if (ast._tag === "Arrays") {
    return listKindOf(ast, kindOf);
  }

  if (ast._tag !== "Union") {
    return undefined;
  }

  const choices = literalsOf(ast);

  if (choices !== undefined) {
    return { _tag: "Choice", choices };
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
    ? invalid(`Choose one of ${choices.map(lower).join(", ")}, not "${text}".`)
    : parsed(found);
};

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
    case "Credential": {
      return textOf(value) ?? "";
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

    default: {
      return kind satisfies never;
    }
  }
};

// Names.

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
    return invalid(
      `There is no option ${name}. Options are named network.<id>.<option> or ui.<option>.`
    );
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
    : invalid(
        `There is no option ${name}. Options are named network.<id>.<option> or ui.<option>.`
      );
};

/**
 * A `ui` option's name.
 * @param option - The option.
 * @returns Its dotted name, such as `ui.time`.
 */
export const uiOptionName = (option: UiOptionName): string => `${uiPrefix}${option}`;

/**
 * A `ui` option's value, from its text syntax, parsed by its Schema, as the JSON the Daemon
 * takes and a device keeps.
 * @param option - The option.
 * @param text - The text.
 * @returns The value, or why the text is not one.
 */
export const parseUiText = (option: UiOptionName, text: string): Parsed<Json> => {
  const field = fieldNamed(uiFields, option);

  if (field === undefined) {
    return invalid(`There is no option ${uiOptionName(option)}.`);
  }

  const json = parseText(field.kind, text);

  if (json._tag === "Invalid") {
    return invalid(`${uiOptionName(option)}: ${json.message}`);
  }

  const codec = Schema.toCodecJson(UiOptions.fields[option]);
  const value = Schema.decodeOption(codec)(json.value);

  return Maybe.isSome(value)
    ? parsed(Schema.encodeUnknownSync(codec)(value.value))
    : invalid(`${uiOptionName(option)} cannot be ${text}.`);
};

/**
 * A `ui` option's value as JSON, as the Daemon takes it.
 * @param option - The option.
 * @param value - Its value.
 * @returns The JSON.
 */
const uiValueJson = (option: UiOptionName, value: UiOptions[UiOptionName]): Json =>
  Schema.encodeUnknownSync(Schema.toCodecJson(UiOptions.fields[option]))(value);

/**
 * A `ui` option's value, shown in its text syntax.
 * @param field - Its field.
 * @param value - Its value, as JSON.
 * @returns The value as the view shows it.
 */
const shownUi = (field: Field, value: Json): Value => ({
  _tag: "Shown",
  text: showText(field.kind, value),
});

/**
 * Every option under `ui`, in the Schema's order, each with the value in effect on this
 * device, the shared one, and this device's override.
 * @param shared - The shared options, once read.
 * @param device - This device's overrides.
 * @returns The options.
 */
export const uiOptionsOf = (
  shared: UiInForce | undefined,
  device: DeviceUi
): readonly UiOption[] => {
  const effective = effectiveUi(shared, device);

  return uiFields.flatMap((field) => {
    const option = decodeUiName(field.key);

    if (Maybe.isNone(option)) {
      return [];
    }

    const name = option.value;
    const own = device[name];

    return [
      {
        _tag: "Ui",
        description: field.description,
        device: own === undefined ? undefined : shownUi(field, uiValueJson(name, own)),
        kind: field.kind,
        name: uiOptionName(name),
        option: name,
        shared:
          shared === undefined
            ? { _tag: "Unset" }
            : shownUi(field, uiValueJson(name, shared.options[name])),
        starts: showText(field.kind, uiValueJson(name, uiDefaults[name])),
        unsettable: true,
        value: shownUi(field, uiValueJson(name, effective[name])),
      },
    ];
  });
};

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
 * A value set at a path of a member's field. A field of a member not in force puts that
 * member in force first, with its fields at what they start with.
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
  const member = members.find((one) => fieldNamed(one.fields, second) !== undefined);
  const current = plain[key];

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
 * Channels' names by.
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
  held: ReadonlySet<string> | undefined
): NetworkOption => {
  const credential = field.kind._tag === "Credential" ? textOf(value) : undefined;

  const shown = (): Value => {
    if (value === undefined) {
      return { _tag: "Unset" };
    }

    return credential === undefined
      ? { _tag: "Shown", text: showText(field.kind, value) }
      : { _tag: "Credential", held: held?.has(credential), name: credential };
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
  held: ReadonlySet<string> | undefined
): readonly NetworkOption[] => {
  const plain: Record = configuration;

  return fields.flatMap((field) => {
    const value = plain[field.key];
    const own = optionOf(network, field, [field.key], value, held);
    const { kind } = field;

    if (kind._tag === "Tagged") {
      const inForce = isRecord(value) ? value : undefined;

      return [
        own,
        ...kind.members.flatMap((member) =>
          member.fields.map((sub) =>
            optionOf(
              network,
              sub,
              [field.key, sub.key],
              inForce?._tag === member.tag ? inForce[sub.key] : undefined,
              held
            )
          )
        ),
      ];
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
  /** Each Network's Configuration, by id, in the order the Networks were listed. */
  readonly networks: ReadonlyMap<NetworkId, Reading>;
  /** The options under `ui` every device shares, as last read or followed, once they are. */
  readonly ui: UiInForce | undefined;
  /** The names of the Credentials the Vault holds, once read. */
  readonly held: ReadonlySet<string> | undefined;
  /** What the last edit from the view came to, when it did not go as asked, in words. */
  readonly notice: string | undefined;
  /** The option being edited in place, by name. */
  readonly editing: string | undefined;
  /** The option the Owner is asked to confirm unsetting, by name. */
  readonly confirming: string | undefined;
  /** The Credential option whose value a password prompt asks for, wherever it was asked. */
  readonly prompting: Prompt | undefined;
}

/** A Credential option whose value is asked for. */
export interface Prompt {
  readonly network: NetworkId;
  readonly path: Path;
  /** Its dotted name. */
  readonly name: string;
}

/**
 * What happened to the options view.
 *
 * - `Listed`: the Networks to read, as `GET /api/networks` listed them.
 * - `Read`, `ReadFailed`: a Network's Configuration was read, or could not be.
 * - `UiRead`: the options under `ui` were read, or followed.
 * - `Held`: the names of the Credentials the Vault holds.
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
  | { readonly _tag: "Held"; readonly names: readonly string[] }
  | { readonly _tag: "Noticed"; readonly message: string | undefined }
  | { readonly _tag: "Editing"; readonly name: string | undefined }
  | { readonly _tag: "Confirming"; readonly name: string | undefined }
  | {
      readonly _tag: "Prompting";
      readonly prompt: { readonly network: NetworkId; readonly path: Path } | undefined;
    };

/** The options view before anything was read. */
export const initialOptions: Options = {
  confirming: undefined,
  editing: undefined,
  held: undefined,
  networks: new Map(),
  notice: undefined,
  prompting: undefined,
  ui: undefined,
};

/**
 * The options view after an event.
 * @param state - The view before.
 * @param event - What happened.
 * @returns The view after.
 */
export const reduceOptions = (state: Options, event: OptionsEvent): Options => {
  switch (event._tag) {
    case "Listed": {
      return {
        ...state,
        networks: new Map(
          event.networks.map((network) => [
            network,
            state.networks.get(network) ?? { _tag: "Reading" },
          ])
        ),
      };
    }

    case "Read": {
      const { configuration, network, sequence } = event;
      const before = state.networks.get(network);

      // An older read that lands late never replaces a newer one.
      if (before?._tag === "Read" && before.sequence > sequence) {
        return state;
      }

      return {
        ...state,
        networks: new Map(state.networks).set(network, { _tag: "Read", configuration, sequence }),
      };
    }

    case "ReadFailed": {
      return {
        ...state,
        networks: new Map(state.networks).set(event.network, {
          _tag: "Failed",
          message: event.message,
        }),
      };
    }

    // An older read that lands late never replaces a newer one.
    case "UiRead": {
      return state.ui !== undefined && state.ui.sequence > event.ui.sequence
        ? state
        : { ...state, ui: event.ui };
    }

    case "Held": {
      return { ...state, held: new Set(event.names) };
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
        prompting:
          prompt === undefined
            ? undefined
            : { ...prompt, name: optionName(prompt.network, prompt.path) },
      };
    }

    default: {
      return event satisfies never;
    }
  }
};

/**
 * The options the view lists, that the filter matches: every option of every Network read,
 * and then every option under `ui`, as it takes effect on this device.
 * @param state - The view.
 * @param filter - What the Owner typed to filter them.
 * @param device - This device's overrides of the options under `ui`.
 * @returns The options, by Network in the order listed, then those under `ui`.
 */
export const listed = (
  state: Options,
  filter: string,
  device: DeviceUi = noOverrides
): readonly Option[] =>
  [
    ...[...state.networks].flatMap(([network, reading]) =>
      reading._tag === "Read" ? optionsOf(network, reading.configuration, state.held) : []
    ),
    ...uiOptionsOf(state.ui, device),
  ].filter((option) => matches(filter, option.name));
