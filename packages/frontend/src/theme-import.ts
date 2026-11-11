/**
 * Terminal themes read into a palette: base16 and base24 schemes, iTerm2's
 * `.itermcolors`, Alacritty's TOML and its older YAML, Kitty's and Ghostty's configuration,
 * and a Windows Terminal scheme. The format is told from the text's own structure, never
 * from a file's name. Each reader parses only the colours a palette needs, by a Schema of
 * the format where it is data, refuses what it cannot read in words, and evaluates nothing:
 * an include, a file a configuration names, or a DTD is never followed.
 *
 * @packageDocumentation
 */
import { Colour, ThemeName, ansiCount } from "@iirc/api/ui";
import type { Palette } from "@iirc/api/ui";
import { Option, Predicate, Result, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Toml, Yaml } from "effect/encoding";

import { fromDisplayP3, hexOf, parseHex } from "./colour.ts";
import type { Parsed } from "./commands.ts";

/** A format a theme can be read from. */
export type ThemeFormat =
  | "base16"
  | "base24"
  | "iTerm2"
  | "Alacritty"
  | "Kitty"
  | "Ghostty"
  | "Windows Terminal";

/** A theme read from text: its format, its palette, and the name it gives itself, if any. */
export interface Imported {
  readonly format: ThemeFormat;
  readonly palette: Palette;
  /** Its own name as a theme's name, such as `gruvbox-dark-medium`, when it gives one. */
  readonly name: ThemeName | undefined;
}

/** The longest text read, 256 KB: no terminal theme comes near it. */
export const importLimit = 256 * 1024;

/** How deep a plist's arrays and dicts may nest. An `.itermcolors` file needs three. */
const plistDepth = 16;

/**
 * How many settings a line of configuration, or values a plist, may hold: far more than any
 * theme needs, which is a few dozen settings or a few hundred values.
 */
export const entryLimit = 4096;

/**
 * A text's lines, split at every line break, `\r\n`, `\r`, or `\n`.
 * @param text - The text.
 * @returns Its lines.
 */
const linesOf = (text: string) => text.split(/\r\n?|\n/u);

const tooMany = `This holds more than ${entryLimit} settings or values, which no theme needs.`;

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

const decodeName = Schema.decodeUnknownOption(ThemeName);

/**
 * A theme's name from the name a file gives itself, such as `Gruvbox dark, medium`, as
 * lower-case words joined by `-`, or none when nothing is left of it.
 * @param text - The name given.
 * @returns The theme's name, or none.
 */
export const nameFrom = (text: string): ThemeName | undefined => {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((one) => one !== "");

  let name = "";

  for (const word of words) {
    const joined = name === "" ? word : `${name}-${word}`;

    if (joined.length > 32) {
      break;
    }

    name = joined;
  }

  return Option.getOrUndefined(decodeName(name));
};

/**
 * A colour from hex text, `#` or `0x` first or neither, short or long.
 * @param text - The text.
 * @returns The colour, or none.
 */
const colourIn = (text: string | undefined): Colour | undefined =>
  text === undefined ? undefined : parseHex(text.trim().replace(/^0x/iu, "#"));

/**
 * A colour as a theme file writes it: hex text, `#` or `0x` first or neither, short or long.
 * Text that is none is kept as it is, which `Colour` then refuses.
 */
const HexText = Schema.String.pipe(
  Schema.decodeTo(
    Colour,
    SchemaTransformation.transform<string, string>({
      decode: (text) => colourIn(text) ?? text,
      encode: (colour) => colour,
    })
  )
);

/** An optional colour, which is left out when it is not hex, as Alacritty's `CellForeground`. */
const OptionalText = Schema.optionalKey(Schema.String);

/** Why the data of a theme is not what its format holds, in words: its first issue, by path. */
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  checkHook: () => "is not a colour as #rrggbb",
  leafHook: (issue) => {
    if (issue._tag === "MissingKey") {
      return "is missing";
    }

    if (issue._tag === "InvalidType") {
      return issue.ast._tag === "String"
        ? "is not a colour as #rrggbb"
        : "is not a group of colours";
    }

    return "cannot be read";
  },
});

/**
 * Data parsed by a format's Schema, or why it is not what the format holds, in words.
 * @param schema - The format's Schema.
 * @param data - The data, as parsed from its text.
 * @returns The format's data.
 */
const parsedBy = <A>(schema: Schema.Decoder<A>, data: Schema.Json): Parsed<A> => {
  const result = Schema.decodeResult(schema)(data);

  if (Result.isSuccess(result)) {
    return parsed(result.success);
  }

  const [first] = formatIssues(result.failure.issue).issues;
  const path = (first?.path ?? []).map(String).join(".");

  return invalid(
    path === ""
      ? "This holds no colours where its format keeps them."
      : `${path} ${first?.message ?? "cannot be read"}.`
  );
};

/** The colours of a palette, each one there or its reason in words, in the palette's order. */
interface Wanted {
  readonly foreground: Parsed<Colour>;
  readonly background: Parsed<Colour>;
  readonly ansi: readonly Parsed<Colour>[];
  readonly cursor: Colour | undefined;
  readonly selection: Colour | undefined;
}

/**
 * A palette from its colours, or the first reason one was not read.
 * @param wanted - The colours.
 * @returns The palette.
 */
const paletteOf = (wanted: Wanted): Parsed<Palette> => {
  const colours: Colour[] = [];

  for (const one of [wanted.foreground, wanted.background, ...wanted.ansi]) {
    if (one._tag === "Invalid") {
      return one;
    }

    colours.push(one.value);
  }

  const [foreground = "#ffffff", background = "#000000", ...ansi] = colours;
  const plain: Palette = { ansi, background, foreground };
  const { cursor, selection } = wanted;
  const cursored: Palette = cursor === undefined ? plain : { ...plain, cursor };

  return parsed(selection === undefined ? cursored : { ...cursored, selection });
};

/**
 * A palette from colours a Schema has parsed already.
 * @param colours - Its colours, and its cursor and selection as text, when given.
 * @returns The palette.
 */
const paletteFrom = (colours: {
  readonly foreground: Colour;
  readonly background: Colour;
  readonly ansi: readonly Colour[];
  readonly cursor?: string | undefined;
  readonly selection?: string | undefined;
}): Parsed<Palette> =>
  paletteOf({
    ansi: colours.ansi.map(parsed),
    background: parsed(colours.background),
    cursor: colourIn(colours.cursor),
    foreground: parsed(colours.foreground),
    selection: colourIn(colours.selection),
  });

/**
 * A theme, from its palette, or why there is none.
 * @param format - Its format.
 * @param palette - Its palette.
 * @param named - The name it gives itself, if any.
 * @returns The theme.
 */
const themeOf = (
  format: ThemeFormat,
  palette: Parsed<Palette>,
  named: string | undefined
): Parsed<Imported> =>
  palette._tag === "Invalid"
    ? palette
    : parsed({
        format,
        name: named === undefined ? undefined : nameFrom(named),
        palette: palette.value,
      });

const indices = Array.from({ length: ansiCount }, (_, index) => index);

// base16 and base24.

/** A scheme's colours: base16's sixteen, and base24's eight more when it is one. */
const BaseColours = Schema.Struct({
  base00: HexText,
  base01: HexText,
  base02: HexText,
  base03: HexText,
  base04: HexText,
  base05: HexText,
  base06: HexText,
  base07: HexText,
  base08: HexText,
  base09: HexText,
  base0A: HexText,
  base0B: HexText,
  base0C: HexText,
  base0D: HexText,
  base0E: HexText,
  base0F: HexText,
  base10: Schema.optionalKey(HexText),
  base11: Schema.optionalKey(HexText),
  base12: Schema.optionalKey(HexText),
  base13: Schema.optionalKey(HexText),
  base14: Schema.optionalKey(HexText),
  base15: Schema.optionalKey(HexText),
  base16: Schema.optionalKey(HexText),
  base17: Schema.optionalKey(HexText),
});

/** A scheme as the current spec has it: its colours under `palette`, and its `name`. */
const CurrentScheme = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  palette: BaseColours,
});

/** A scheme as the older spec had it: its colours at the top, and its `scheme`. */
const OlderScheme = Schema.Struct({
  ...BaseColours.fields,
  scheme: Schema.optionalKey(Schema.String),
});

/**
 * Which base colour each ANSI colour takes, as tinted-theming's styling guides map them:
 * base16's bright colours repeat its normal ones, and base24 has its own.
 */
const base16Ansi = [
  "base00",
  "base08",
  "base0B",
  "base0A",
  "base0D",
  "base0E",
  "base0C",
  "base05",
  "base03",
  "base08",
  "base0B",
  "base0A",
  "base0D",
  "base0E",
  "base0C",
  "base07",
] as const;

const base24Ansi = [
  ...base16Ansi.slice(0, 9),
  "base12",
  "base14",
  "base13",
  "base16",
  "base17",
  "base15",
  "base07",
] as const;

/**
 * A base16 or base24 scheme's theme, from its colours: base24's when all its bright colours
 * are given.
 * @param colours - The colours.
 * @param named - The name it gives itself.
 * @returns The theme.
 */
const fromBaseColours = (
  colours: typeof BaseColours.Type,
  named: string | undefined
): Parsed<Imported> => {
  const bright = [
    colours.base12,
    colours.base13,
    colours.base14,
    colours.base15,
    colours.base16,
    colours.base17,
  ];

  const base24 = bright.every((one) => one !== undefined);
  const mapping = base24 ? base24Ansi : base16Ansi;

  const palette = paletteFrom({
    ansi: mapping.map((key) => colours[key] ?? colours.base05),
    background: colours.base00,
    cursor: colours.base05,
    foreground: colours.base05,
    selection: colours.base02,
  });

  return themeOf(base24 ? "base24" : "base16", palette, named);
};

/**
 * A base16 or base24 scheme: its colours under `palette`, as the current spec has them,
 * or at the top, as the older one did.
 * @param data - The YAML, parsed.
 * @returns The theme.
 */
const fromBase = (data: Schema.Json): Parsed<Imported> => {
  if (Predicate.hasProperty(data, "palette")) {
    const scheme = parsedBy(CurrentScheme, data);

    return scheme._tag === "Invalid"
      ? scheme
      : fromBaseColours(scheme.value.palette, scheme.value.name);
  }

  const scheme = parsedBy(OlderScheme, data);

  return scheme._tag === "Invalid" ? scheme : fromBaseColours(scheme.value, scheme.value.scheme);
};

// Alacritty.

/** Eight colours by name, as Alacritty's `normal` and `bright` have them. */
const NamedAnsi = Schema.Struct({
  black: HexText,
  blue: HexText,
  cyan: HexText,
  green: HexText,
  magenta: HexText,
  red: HexText,
  white: HexText,
  yellow: HexText,
});

/** The ANSI colours' names, in order, as Alacritty names them. */
const ansiNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** An Alacritty theme: `colors.primary`, `normal`, and `bright`, with its cursor and selection. */
const Alacritty = Schema.Struct({
  colors: Schema.Struct({
    bright: NamedAnsi,
    cursor: Schema.optionalKey(Schema.Struct({ cursor: OptionalText })),
    normal: NamedAnsi,
    primary: Schema.Struct({ background: HexText, foreground: HexText }),
    selection: Schema.optionalKey(Schema.Struct({ background: OptionalText })),
  }),
});

/**
 * An Alacritty theme, from its TOML or YAML.
 * @param data - The data, parsed.
 * @returns The theme.
 */
const fromAlacritty = (data: Schema.Json): Parsed<Imported> => {
  const theme = parsedBy(Alacritty, data);

  if (theme._tag === "Invalid") {
    return theme;
  }

  const { colors } = theme.value;

  const palette = paletteFrom({
    ansi: [
      ...ansiNames.map((name) => colors.normal[name]),
      ...ansiNames.map((name) => colors.bright[name]),
    ],
    background: colors.primary.background,
    cursor: colors.cursor?.cursor,
    foreground: colors.primary.foreground,
    selection: colors.selection?.background,
  });

  return themeOf("Alacritty", palette, undefined);
};

// Windows Terminal.

/** Windows Terminal's names for the ANSI colours, in order: magenta is `purple`. */
const terminalNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightCyan",
  "brightWhite",
] as const;

/** A Windows Terminal scheme, as its settings' `schemes` hold each. */
const TerminalScheme = Schema.Struct({
  background: HexText,
  black: HexText,
  blue: HexText,
  brightBlack: HexText,
  brightBlue: HexText,
  brightCyan: HexText,
  brightGreen: HexText,
  brightPurple: HexText,
  brightRed: HexText,
  brightWhite: HexText,
  brightYellow: HexText,
  cursorColor: OptionalText,
  cyan: HexText,
  foreground: HexText,
  green: HexText,
  name: Schema.optionalKey(Schema.String),
  purple: HexText,
  red: HexText,
  selectionBackground: OptionalText,
  white: HexText,
  yellow: HexText,
});

/** A Windows Terminal settings file, which holds many schemes. */
const TerminalSettings = Schema.Struct({ schemes: Schema.Array(Schema.Json) });

/**
 * A Windows Terminal scheme: an object with `black` to `brightWhite`, `background`, and
 * `foreground`. A settings file, with many, is refused, saying to paste one.
 * @param data - The JSON, parsed.
 * @returns The theme.
 */
const fromWindowsTerminal = (data: Schema.Json): Parsed<Imported> => {
  const settings = Schema.decodeUnknownOption(TerminalSettings)(data);

  if (Option.isSome(settings)) {
    return invalid(
      `This is a settings file with ${settings.value.schemes.length} schemes. Paste one scheme, the object in braces.`
    );
  }

  const scheme = parsedBy(TerminalScheme, data);

  if (scheme._tag === "Invalid") {
    return scheme;
  }

  const { value } = scheme;

  const palette = paletteFrom({
    ansi: terminalNames.map((name) => value[name]),
    background: value.background,
    cursor: value.cursorColor,
    foreground: value.foreground,
    selection: value.selectionBackground,
  });

  return themeOf("Windows Terminal", palette, value.name);
};

// Kitty and Ghostty: a setting a line.

/**
 * A colour a setting gives, or why there is none.
 * @param text - The setting's value, or none.
 * @param name - What the file calls it, to say which one is wrong.
 * @returns The colour.
 */
const colourOf = (text: string | undefined, name: string): Parsed<Colour> => {
  if (text === undefined) {
    return invalid(`${name} is missing.`);
  }

  const colour = colourIn(text);

  return colour === undefined ? invalid(`${name} is not a colour as #rrggbb.`) : parsed(colour);
};

/**
 * The settings of a configuration a setting a line, each key's values in order, from lines
 * split by `separator`, whose groups are `key` and `value`. Blank lines and those starting
 * with `#` are comments. Each value is appended to its key's own list, so reading is linear,
 * and more than `entryLimit` settings are refused.
 * @param text - The text.
 * @param separator - What parts a key from its value, matched against one trimmed line.
 * @returns Each key's values, or why they are not read.
 */
const settingsOf = (
  text: string,
  separator: RegExp
): Parsed<ReadonlyMap<string, readonly string[]>> => {
  const settings = new Map<string, string[]>();
  let count = 0;

  for (const raw of linesOf(text)) {
    const line = raw.trim();
    const parts = line === "" || line.startsWith("#") ? undefined : separator.exec(line)?.groups;

    if (parts !== undefined) {
      count += 1;

      if (count > entryLimit) {
        return invalid(tooMany);
      }

      const key = (parts.key ?? "").toLowerCase();
      const values = settings.get(key);
      const value = (parts.value ?? "").trim();

      if (values === undefined) {
        settings.set(key, [value]);
      } else {
        values.push(value);
      }
    }
  }

  return parsed(settings);
};

/**
 * A setting's value: the last given, as a later line overrides an earlier one.
 * @param settings - The settings.
 * @param key - Its key.
 * @returns The value, or none.
 */
const lastOf = (settings: ReadonlyMap<string, readonly string[]>, key: string) =>
  settings.get(key)?.at(-1);

/**
 * A Kitty theme: `foreground`, `background`, `color0` to `color15`, `cursor`, and
 * `selection_background`, each a key and a value apart by whitespace. An `include` is not
 * followed.
 * @param text - The text.
 * @returns The theme.
 */
const fromKitty = (text: string): Parsed<Imported> => {
  const read = settingsOf(text, /^(?<key>\S+)\s+(?<value>.*)$/u);

  if (read._tag === "Invalid") {
    return read;
  }

  const settings = read.value;
  const colour = (key: string) => colourOf(lastOf(settings, key), key);

  const palette = paletteOf({
    ansi: indices.map((index) => colour(`color${index}`)),
    background: colour("background"),
    cursor: colourIn(lastOf(settings, "cursor")),
    foreground: colour("foreground"),
    selection: colourIn(lastOf(settings, "selection_background")),
  });

  return themeOf("Kitty", palette, undefined);
};

/**
 * A Ghostty theme: `palette = N=#rrggbb` for each of the sixteen, `background`,
 * `foreground`, `cursor-color`, and `selection-background`, each a key and a value apart
 * by `=`. A `config-file` is not followed.
 * @param text - The text.
 * @returns The theme.
 */
const fromGhostty = (text: string): Parsed<Imported> => {
  const read = settingsOf(text, /^(?<key>[^=\s]+)\s*=\s*(?<value>.*)$/u);

  if (read._tag === "Invalid") {
    return read;
  }

  const settings = read.value;
  const colour = (key: string) => colourOf(lastOf(settings, key), key);
  const entries = new Map<number, string>();

  for (const entry of settings.get("palette") ?? []) {
    const parts = /^(?<index>\d{1,3})\s*=\s*(?<value>.*)$/u.exec(entry)?.groups;

    if (parts !== undefined) {
      entries.set(Number(parts.index), parts.value ?? "");
    }
  }

  const palette = paletteOf({
    ansi: indices.map((index) => colourOf(entries.get(index), `palette ${index}`)),
    background: colour("background"),
    cursor: colourIn(lastOf(settings, "cursor-color")),
    foreground: colour("foreground"),
    selection: colourIn(lastOf(settings, "selection-background")),
  });

  return themeOf("Ghostty", palette, undefined);
};

// iTerm2: the subset of an XML property list an `.itermcolors` file is.

/** A value of a property list: a dict, an array, a number, text, or anything else. */
type Plist =
  | { readonly _tag: "Dict"; readonly entries: ReadonlyMap<string, Plist> }
  | { readonly _tag: "Array"; readonly items: readonly Plist[] }
  | { readonly _tag: "Number"; readonly value: number }
  | { readonly _tag: "Text"; readonly value: string }
  | { readonly _tag: "Other" };

/** One piece of XML: an opening or closing tag, an empty one, or the text between. */
type Token =
  | { readonly _tag: "Open"; readonly name: string }
  | { readonly _tag: "Close"; readonly name: string }
  | { readonly _tag: "Empty"; readonly name: string }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Declaration" };

const entities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

/**
 * A character reference's code point, from `#x` and hex or `#` and decimal.
 * @param reference - The reference, without its `&` and `;`.
 * @returns The code point, or none when it names none.
 */
const codePointOf = (reference: string): number | undefined => {
  const hex = /^#x(?<digits>[0-9a-f]+)$/iu.exec(reference)?.groups?.digits;
  const decimal = /^#(?<digits>\d+)$/u.exec(reference)?.groups?.digits;
  const code = hex === undefined ? Number(decimal ?? "") : Number.parseInt(hex, 16);

  return Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff ? code : undefined;
};

/**
 * XML text with its five predefined entities and character references read. Nothing else
 * is an entity, since no DTD is read.
 * @param text - The text.
 * @returns The text read.
 */
const unescaped = (text: string) =>
  text.replaceAll(/&(?<reference>#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, reference: string) => {
    const code = codePointOf(reference);

    return code === undefined ? (entities.get(reference) ?? whole) : String.fromCodePoint(code);
  });

/**
 * A tag's token, from what lies between its `<` and `>`.
 * @param inside - The tag's text.
 * @returns Its token.
 */
const tagOf = (inside: string): Token => {
  const name = /^\/?\s*(?<name>[A-Za-z][\w.-]*)/u.exec(inside)?.groups?.name ?? "";

  if (inside.startsWith("/")) {
    return { _tag: "Close", name };
  }

  return inside.endsWith("/") ? { _tag: "Empty", name } : { _tag: "Open", name };
};

/**
 * The XML's tags, text, and declarations, in order, skipping its comments, or why it cannot
 * be read. A declaration, `<?…?>` or `<!…>`, is a token of its own, so the reader takes
 * one only before the root, and a doctype with an internal subset, which could declare
 * entities, is refused.
 * @param text - The XML.
 * @returns Its tokens.
 */
const tokensOf = (text: string): Parsed<readonly Token[]> => {
  const tokens: Token[] = [];
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf("<", at);
    const end = open === -1 ? text.length : open;

    if (end > at) {
      tokens.push({ _tag: "Text", text: text.slice(at, end) });
    }

    if (open === -1) {
      break;
    }

    const comment = text.startsWith("<!--", open);
    const instruction = text.startsWith("<?", open);
    let ending = ">";

    if (comment) {
      ending = "-->";
    } else if (instruction) {
      ending = "?>";
    }

    const close = text.indexOf(ending, open + 2);

    if (close === -1) {
      return invalid("This XML ends inside a tag, a comment, or a declaration.");
    }

    const inside = text.slice(open + 1, close);

    if (!comment && inside.startsWith("!") && inside.includes("[")) {
      return invalid("This plist declares a DTD of its own, which is never read.");
    }

    if (instruction || (!comment && inside.startsWith("!"))) {
      tokens.push({ _tag: "Declaration" });
    } else if (!comment) {
      tokens.push(tagOf(inside));
    }

    at = close + ending.length;
  }

  return parsed(tokens);
};

/** A reader of a plist's tokens, from a place it moves along. */
interface Reader {
  readonly tokens: readonly Token[];
  at: number;
  /** How many values it has read, at most `entryLimit`. */
  values: number;
}

const isBlank = (token: Token | undefined) => token?._tag === "Text" && token.text.trim() === "";

/**
 * The next token that is not whitespace between tags.
 * @param reader - Where to read from, moved past it.
 * @returns The token, or none at the end.
 */
const nextToken = (reader: Reader): Token | undefined => {
  for (let token = reader.tokens[reader.at]; isBlank(token); token = reader.tokens[reader.at]) {
    reader.at += 1;
  }

  const token = reader.tokens[reader.at];

  reader.at += 1;

  return token;
};

/**
 * The text of an element whose opening tag was just read, up to its closing tag.
 * @param reader - Where to read from.
 * @param name - The element.
 * @returns Its text, or why it has none.
 */
const textUntilClose = (reader: Reader, name: string): Parsed<string> => {
  let text = "";

  for (
    let token = reader.tokens[reader.at];
    token?._tag === "Text";
    token = reader.tokens[reader.at]
  ) {
    text += token.text;
    reader.at += 1;
  }

  const close = reader.tokens[reader.at];

  reader.at += 1;

  return close?._tag === "Close" && close.name === name
    ? parsed(unescaped(text))
    : invalid(`This plist's <${name}> is not closed.`);
};

/**
 * A dict's entries, each a key and then a value, up to its closing tag.
 * @param reader - Where to read from, after `<dict>`.
 * @param depth - How deep the dict is.
 * @returns The dict.
 */
const dictOf = (reader: Reader, depth: number): Parsed<Plist> => {
  const entries = new Map<string, Plist>();

  for (;;) {
    const key = nextToken(reader);

    if (key?._tag === "Close") {
      return key.name === "dict"
        ? parsed({ _tag: "Dict", entries })
        : invalid(`This plist's <dict> is closed by </${key.name}>.`);
    }

    if (key?._tag !== "Open" || key.name !== "key") {
      return invalid("This plist has a dict whose entries are not a key, then a value.");
    }

    const name = textUntilClose(reader, "key");

    if (name._tag === "Invalid") {
      return name;
    }

    // oxlint-disable-next-line no-use-before-define -- a dict holds values, which may be dicts.
    const value = plistValue(reader, depth + 1);

    if (value._tag === "Invalid") {
      return value;
    }

    entries.set(name.value, value.value);
  }
};

/**
 * An array's items, up to its closing tag.
 * @param reader - Where to read from, after `<array>`.
 * @param depth - How deep the array is.
 * @returns The array.
 */
const arrayOf = (reader: Reader, depth: number): Parsed<Plist> => {
  const items: Plist[] = [];

  while (reader.at < reader.tokens.length) {
    const before = reader.at;
    const closing = nextToken(reader);

    if (closing?._tag === "Close") {
      return closing.name === "array"
        ? parsed({ _tag: "Array", items })
        : invalid(`This plist's <array> is closed by </${closing.name}>.`);
    }

    reader.at = before;

    // oxlint-disable-next-line no-use-before-define -- an array holds values, which may be arrays.
    const value = plistValue(reader, depth + 1);

    if (value._tag === "Invalid") {
      return value;
    }

    items.push(value.value);
  }

  return invalid("This plist's <array> is not closed.");
};

/**
 * A value that holds text: a number from `<real>` or `<integer>`, text from `<string>`,
 * and anything else, such as `<data>`, kept as nothing.
 * @param reader - Where to read from, after its opening tag.
 * @param name - Its element.
 * @returns The value.
 */
const leafOf = (reader: Reader, name: string): Parsed<Plist> => {
  const text = textUntilClose(reader, name);

  if (text._tag === "Invalid") {
    return text;
  }

  const trimmed = text.value.trim();

  if (name === "real" || name === "integer") {
    const value = Number(trimmed);

    return trimmed !== "" && Number.isFinite(value)
      ? parsed({ _tag: "Number", value })
      : invalid(`This plist's <${name}>${trimmed}</${name}> is not a number.`);
  }

  return parsed(name === "string" ? { _tag: "Text", value: text.value } : { _tag: "Other" });
};

/**
 * One plist value, from the token that begins it, nested at most `plistDepth` deep.
 * @param reader - Where to read from.
 * @param depth - How deep it is.
 * @returns The value, or why it cannot be read.
 */
const plistValue = (reader: Reader, depth: number): Parsed<Plist> => {
  const token = nextToken(reader);

  reader.values += 1;

  if (reader.values > entryLimit) {
    return invalid(tooMany);
  }

  if (depth > plistDepth) {
    return invalid("This plist nests too deeply to be a theme.");
  }

  if (token === undefined) {
    return invalid("This plist ends before its last value does.");
  }

  if (token._tag === "Empty") {
    return parsed({ _tag: "Other" });
  }

  if (token._tag !== "Open") {
    return invalid("This plist has something other than a value where a value goes.");
  }

  if (token.name === "dict") {
    return dictOf(reader, depth);
  }

  return token.name === "array" ? arrayOf(reader, depth) : leafOf(reader, token.name);
};

/**
 * A colour from an iTerm2 colour dict: its red, green, and blue components from 0 to 1,
 * in sRGB, or in Display P3 when its colour space says `P3`. Any other space, such as the
 * `Calibrated` an older file has or none, is read as sRGB, which it nearly is.
 * @param value - The dict.
 * @param name - Its key, to say which one is wrong.
 * @returns The colour.
 */
const itermColour = (value: Plist | undefined, name: string): Parsed<Colour> => {
  if (value === undefined) {
    return invalid(`${name} is missing.`);
  }

  if (value._tag !== "Dict") {
    return invalid(`${name} is not a colour's dict.`);
  }

  const component = (key: string) => {
    const one = value.entries.get(`${key} Component`);

    return one?._tag === "Number" ? Math.min(1, Math.max(0, one.value)) : undefined;
  };

  const r = component("Red");
  const g = component("Green");
  const b = component("Blue");

  if (r === undefined || g === undefined || b === undefined) {
    return invalid(`${name} lacks a red, green, or blue component.`);
  }

  const space = value.entries.get("Color Space");
  const p3 = space?._tag === "Text" && space.value.trim().toLowerCase() === "p3";

  return parsed(hexOf(p3 ? fromDisplayP3({ b, g, r }) : { b, g, r }));
};

/**
 * An iTerm2 theme: a plist whose dict holds `Ansi 0 Color` to `Ansi 15 Color`,
 * `Background Color`, and `Foreground Color`, with `Cursor Color` and `Selection Color`
 * when given, its declarations before it and only comments after it.
 * @param text - The XML.
 * @returns The theme.
 */
const fromIterm = (text: string): Parsed<Imported> => {
  const tokens = tokensOf(text);

  if (tokens._tag === "Invalid") {
    return tokens;
  }

  const reader: Reader = { at: 0, tokens: tokens.value, values: 0 };
  let first = nextToken(reader);

  // Declarations come only before the root.
  while (first?._tag === "Declaration") {
    first = nextToken(reader);
  }

  if (first?._tag !== "Open" || first.name !== "plist") {
    return invalid("This XML is not a plist.");
  }

  const root = plistValue(reader, 1);

  if (root._tag === "Invalid") {
    return root;
  }

  const end = nextToken(reader);

  if (end?._tag !== "Close" || end.name !== "plist") {
    return invalid("This plist's <plist> is not closed after its one value.");
  }

  if (nextToken(reader) !== undefined) {
    return invalid("This plist goes on after </plist>, which only comments may.");
  }

  if (root.value._tag !== "Dict") {
    return invalid("This plist holds no dict of colours.");
  }

  const { entries } = root.value;
  const colour = (key: string) => itermColour(entries.get(key), key);

  const optional = (key: string) => {
    const one = entries.has(key) ? colour(key) : undefined;

    return one?._tag === "Parsed" ? one.value : undefined;
  };

  const palette = paletteOf({
    ansi: indices.map((index) => colour(`Ansi ${index} Color`)),
    background: colour("Background Color"),
    cursor: optional("Cursor Color"),
    foreground: colour("Foreground Color"),
    selection: optional("Selection Color"),
  });

  return themeOf("iTerm2", palette, undefined);
};

// Telling the format.

/** How the text is laid out, told from its structure, before it is read as one format. */
type Layout = "Plist" | "Json" | "Base" | "AlacrittyToml" | "AlacrittyYaml" | "Ghostty" | "Kitty";

/** In which order layouts are chosen, when a text's lines say more than one. */
const layoutOrder: readonly Layout[] = [
  "Base",
  "AlacrittyToml",
  "AlacrittyYaml",
  "Ghostty",
  "Kitty",
];

const ghosttyKeys: ReadonlySet<string> = new Set(["palette", "background", "foreground"]);

const kittyKey = /^(?:color\d{1,3}|background|foreground)$/u;

/**
 * Which layout one line of text says, if any, from its first word or its structure. Each
 * test reads the one line, anchored at its start, so none can scan past it.
 * @param raw - The line, as it is.
 * @returns The layout it says, or none.
 */
const lineLayout = (raw: string): Layout | undefined => {
  const line = raw.trim();

  if (line === "" || line.startsWith("#")) {
    return undefined;
  }

  if (/^["']?base0[0-9a-f]["']?\s*:/iu.test(line)) {
    return "Base";
  }

  if (line.startsWith("[") && line.includes("]")) {
    const table = line.slice(1, line.indexOf("]")).trim();

    if (table === "colors" || table.startsWith("colors.")) {
      return "AlacrittyToml";
    }
  }

  const equals = line.indexOf("=");
  const key = equals === -1 ? "" : line.slice(0, equals).trim();

  if (key.startsWith("colors.")) {
    return "AlacrittyToml";
  }

  if (raw.startsWith("colors") && raw.slice("colors".length).trimStart().startsWith(":")) {
    return "AlacrittyYaml";
  }

  if (ghosttyKeys.has(key)) {
    return "Ghostty";
  }

  const space = line.search(/\s/u);

  return space !== -1 && kittyKey.test(line.slice(0, space)) ? "Kitty" : undefined;
};

/**
 * The layout of a theme's text, from its structure, in one pass over its lines: XML or a
 * JSON object by what it starts with, and otherwise by what its lines say, the first in
 * `layoutOrder` of those any line says. A line that says `Base` settles it at once.
 * @param text - The text.
 * @returns The layout, or none.
 */
const layoutOf = (text: string): Layout | undefined => {
  const lines = linesOf(text);
  const said = new Set<Layout>();
  let first: string | undefined;

  for (const raw of lines) {
    const start = raw.trimStart();

    if (first === undefined && start !== "") {
      first = start;

      if (first.startsWith("<")) {
        return "Plist";
      }

      if (first.startsWith("{")) {
        return "Json";
      }
    }

    const layout = lineLayout(raw);

    if (layout === "Base") {
      return layout;
    }

    if (layout !== undefined) {
      said.add(layout);
    }
  }

  return layoutOrder.find((layout) => said.has(layout));
};

/**
 * YAML parsed, or why it could not be.
 * @param text - The text.
 * @returns The data.
 */
const yamlOf = (text: string): Parsed<Schema.Json> => {
  try {
    const data = Schema.decodeUnknownOption(Schema.Json)(Yaml.parse(text));

    return Option.isSome(data) ? parsed(data.value) : invalid("This YAML holds no colours.");
  } catch (error) {
    return invalid(
      `This YAML cannot be read: ${error instanceof Error ? error.message : "it is not YAML"}.`
    );
  }
};

/**
 * JSON parsed, or why it could not be.
 * @param text - The text.
 * @returns The data.
 */
const jsonOf = (text: string): Parsed<Schema.Json> => {
  const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Json))(text);

  return Option.isSome(decoded)
    ? parsed(decoded.value)
    : invalid("This JSON cannot be read: it is not JSON.");
};

/**
 * TOML parsed, or why it could not be.
 * @param text - The text.
 * @returns The data.
 */
const tomlOf = (text: string): Parsed<Schema.Json> => {
  const read = Toml.parse(text);

  if (Result.isFailure(read)) {
    return invalid(`This TOML cannot be read: ${read.failure.message}.`);
  }

  // A date has no place in a theme, so data that holds one is no theme.
  const data = Schema.decodeUnknownOption(Schema.Json)(read.success);

  return Option.isSome(data) ? parsed(data.value) : invalid("This TOML holds no colours.");
};

/**
 * A theme from data parsed from its text, or why the text could not be parsed.
 * @param data - The data, or why there is none.
 * @param from - How the theme is read from it.
 * @returns The theme.
 */
const readFrom = (
  data: Parsed<Schema.Json>,
  from: (value: Schema.Json) => Parsed<Imported>
): Parsed<Imported> => (data._tag === "Invalid" ? data : from(data.value));

/**
 * A theme read from text in any of the formats, told from the text itself. Text longer
 * than `importLimit` is refused unread.
 * @param text - The text, as pasted or read from a file.
 * @returns The theme, or why it cannot be read, in words.
 */
export const importTheme = (text: string): Parsed<Imported> => {
  if (text.length > importLimit) {
    return invalid("This is longer than 256 KB, which no terminal theme is.");
  }

  const layout = layoutOf(text);

  switch (layout) {
    case "Plist": {
      return fromIterm(text);
    }

    case "Json": {
      return readFrom(jsonOf(text), fromWindowsTerminal);
    }

    case "Base": {
      return readFrom(yamlOf(text), fromBase);
    }

    case "AlacrittyToml": {
      return readFrom(tomlOf(text), fromAlacritty);
    }

    case "AlacrittyYaml": {
      return readFrom(yamlOf(text), fromAlacritty);
    }

    case "Ghostty": {
      return fromGhostty(text);
    }

    case "Kitty": {
      return fromKitty(text);
    }

    case undefined: {
      return invalid(
        "This is not a theme iirc reads: base16 or base24 YAML, iTerm2's .itermcolors, Alacritty's TOML, Kitty's or Ghostty's configuration, or a Windows Terminal scheme."
      );
    }

    default: {
      return layout satisfies never;
    }
  }
};
