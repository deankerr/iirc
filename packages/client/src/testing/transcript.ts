/**
 * The transcript format: one item per line. `parse` turns text into items, and `print`
 * turns items back into text, so `print(parse(text))` is `text` for any text `print`
 * wrote. Ported on purpose from the transcript spike, with ` tls` on a dial, an escaped
 * form for bytes that are not text, whole-item `SecretLine` placeholders, and named
 * Owner, Runtime, and expectation items.
 *
 * @packageDocumentation
 */
import { CredentialName, SecretLine } from "@iirc/protocol/line";
import { Result, Schema } from "effect";

import { FeatureName } from "../ids.ts";
import { CloseReason, UnfilledReason } from "../input.ts";
import type { SayKind } from "../input.ts";
import type { News } from "../news.ts";

/** The instant a transcript's clock starts at: 2026-01-01T00:00:00.000Z. */
export const epoch = 1_767_225_600_000;

/** One change an `!! configure` item makes to the scenario's Configuration. */
export type Change =
  /** `+#iirc`, or `+#iirc key=name` with its key named as a Credential. */
  | { readonly _tag: "Join"; readonly channel: string; readonly key: CredentialName | undefined }
  /** `-#iirc`. */
  | { readonly _tag: "Part"; readonly channel: string }
  /** `enable`. */
  | { readonly _tag: "Enable" }
  /** `disable`. */
  | { readonly _tag: "Disable" }
  /** `decline=multi-prefix`: the Owner turns a Feature off. */
  | { readonly _tag: "Decline"; readonly feature: FeatureName }
  /** `accept=multi-prefix`: the Owner stops declining a Feature. */
  | { readonly _tag: "Accept"; readonly feature: FeatureName };

/** What the Owner does, written after `!!`. */
export type Owner =
  /** `!! configure` with its changes, if any. Sends the Configuration whole. */
  | { readonly _tag: "Configure"; readonly changes: readonly Change[] }
  /** `!! say #iirc :hello`, `!! notice …`, or `!! action …`. Intent ids are given in order. */
  | { readonly _tag: "Say"; readonly kind: SayKind; readonly target: string; readonly text: string }
  /** `!! retry`. */
  | { readonly _tag: "Retry" };

/** One line of a transcript. */
export type Item =
  /** `<< …`: the Ircd sent these bytes, without their line ending. */
  | { readonly _tag: "Received"; readonly bytes: Uint8Array }
  /** `>> …`: the Client sends these bytes. */
  | { readonly _tag: "Sent"; readonly bytes: Uint8Array }
  /** `>> {AuthenticatePlain credential=iirc authcid=iirc authzid=iirc}`: the Client sends a SecretLine. */
  | { readonly _tag: "SentSecret"; readonly line: SecretLine }
  /** `-> dial host:port`, with ` tls` for a TLS Connection. */
  | { readonly _tag: "Dial"; readonly host: string; readonly port: number; readonly tls: boolean }
  /** `-> hangup`. */
  | { readonly _tag: "Hangup" }
  /** `== opened`. */
  | { readonly _tag: "Opened" }
  /** `== closed Reset`. */
  | { readonly _tag: "Closed"; readonly reason: CloseReason }
  /** `== started`: the Runtime has started. */
  | { readonly _tag: "Started" }
  /** `== unfilled Missing`: the last SecretLine written could not be filled. */
  | { readonly _tag: "Unfilled"; readonly reason: UnfilledReason }
  /** `== fired ping t+30s`: a timer fires now, with the instant its `Wake` set, stale or not. */
  | { readonly _tag: "Fired"; readonly timer: string; readonly due: number }
  /** `== connection 1`: later Transport inputs come from this Connection, until the next dial. */
  | { readonly _tag: "Connection"; readonly connection: number }
  /** `!! …`: an Owner input. */
  | { readonly _tag: "Owner"; readonly owner: Owner }
  /** `+60s`, `+250ms`, or `+2m`: the fake clock moves on, and due timers fire. */
  | { readonly _tag: "Advance"; readonly millis: number }
  /** `?? ignored Malformed MODE`: a News expectation, in the form `describeNews` writes. */
  | { readonly _tag: "Expect"; readonly news: News["_tag"]; readonly text: string }
  /** `...`: any outputs and News, up to the next expectation. */
  | { readonly _tag: "Any" }
  /** `# text`. */
  | { readonly _tag: "Comment"; readonly text: string }
  /** An empty line, which separates parts for a reader. */
  | { readonly _tag: "Blank" };

/** Why a line of a transcript is not an item. */
export interface ParseError {
  /** The 1-based line number, or 0 for the text as a whole. */
  readonly line: number;
  readonly message: string;
  readonly text: string;
}

// Bytes

const encoder = new TextEncoder();

// A decoder strips a leading byte order mark unless told not to, which would change the
// bytes a transcript holds. Every decoder here keeps it.
const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** U+FEFF, a byte order mark, which is invisible as text, so it is always escaped. */
const bom = "\uFEFF";

const backslash = 0x5c;
const space = 0x20;
const del = 0x7f;
const openBrace = 0x7b;
const hexPattern = /^[0-9a-f]{2}$/u;

// Whether a byte must be escaped when it appears in a Line.
const isControl = (byte: number): boolean => byte < space || byte === del;

const hex = (byte: number): string => `\\x${byte.toString(16).padStart(2, "0")}`;

const decodeStrict = (bytes: Uint8Array): string | undefined => {
  try {
    return strict.decode(bytes);
  } catch {
    return undefined;
  }
};

// The width a UTF-8 sequence's first byte promises, or 0 for a byte no sequence starts with.
const promisedWidth = (first: number): number => {
  if (first < 0x80) {
    return 1;
  }

  if (first >= 0xc2 && first < 0xe0) {
    return 2;
  }

  if (first >= 0xe0 && first < 0xf0) {
    return 3;
  }

  return first >= 0xf0 && first < 0xf5 ? 4 : 0;
};

// The length of the valid UTF-8 sequence at `index`, or 0 if there is none.
const utf8Width = (bytes: Uint8Array, index: number): number => {
  const width = promisedWidth(bytes[index] ?? 0);

  if (width <= 1) {
    return width;
  }

  return decodeStrict(bytes.subarray(index, index + width)) === undefined ? 0 : width;
};

// Escapes `\`, control bytes, bytes that are not UTF-8, and a trailing space.
const escapeBytes = (bytes: Uint8Array): string => {
  let out = "";
  let index = 0;

  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    const width = utf8Width(bytes, index);

    const char = width === 0 ? "" : lenient.decode(bytes.subarray(index, index + width));

    if (byte === backslash) {
      out += "\\\\";
    } else if (isControl(byte) || width === 0 || (byte === space && index === bytes.length - 1)) {
      out += hex(byte);
    } else if (char === bom) {
      out += [...bytes.subarray(index, index + width)].map(hex).join("");
      index += width;
      continue;
    } else {
      out += char;
      index += width;
      continue;
    }

    index += 1;
  }

  return out;
};

const unescapeBytes = (text: string): Uint8Array | undefined => {
  const out: number[] = [];
  let index = 0;

  while (index < text.length) {
    const next = text.indexOf("\\", index);
    out.push(...encoder.encode(text.slice(index, next === -1 ? text.length : next)));

    if (next === -1) {
      break;
    }

    const code = text.slice(next + 2, next + 4);

    if (text[next + 1] === "\\") {
      out.push(backslash);
      index = next + 2;
    } else if (text[next + 1] === "x" && hexPattern.test(code)) {
      out.push(Number.parseInt(code, 16));
      index = next + 4;
    } else {
      return undefined;
    }
  }

  return new Uint8Array(out);
};

// Placeholders

type SecretKind = SecretLine["_tag"];

const isSecretKind = Schema.is(Schema.Literals(["AuthenticatePlain", "JoinWithKey", "Pass"]));
const decodeSecret = Schema.decodeUnknownResult(SecretLine);

// Each case's fields but `credential`, in the order a placeholder writes them.
const secretFields = (kind: SecretKind): readonly string[] =>
  Object.keys(SecretLine.cases[kind].fields)
    .filter((key) => key !== "_tag" && key !== "credential")
    .toSorted();

const mustEscapeInField = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;

  return code <= space || code === del || char === "\\" || char === "{" || char === "}";
};

// Writes a field's value so that it holds no space or brace.
const escapeField = (value: string): string =>
  Array.from(value, (char) => {
    if (char === "\\") {
      return "\\\\";
    }

    return mustEscapeInField(char) ? hex(char.codePointAt(0) ?? 0) : char;
  }).join("");

const unescapeField = (text: string): string | undefined => {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? "";

    if (char !== "\\") {
      out += char;
      index += 1;
      continue;
    }

    const code = text.slice(index + 2, index + 4);

    if (text[index + 1] === "\\") {
      out += "\\";
      index += 2;
    } else if (text[index + 1] === "x" && hexPattern.test(code)) {
      out += String.fromCodePoint(Number.parseInt(code, 16));
      index += 4;
    } else {
      return undefined;
    }
  }

  return out;
};

/**
 * Writes a SecretLine as a placeholder: its kind, the Credential's name, and every other
 * field, so a strict match checks them all and the value never appears.
 * @param line - The SecretLine.
 * @returns The placeholder, such as `{Pass credential=libera}`.
 */
const writeSecret = (line: SecretLine): string => {
  const record: Readonly<Record<string, string>> = line;

  const fields = ["credential", ...secretFields(line._tag)].map(
    (key) => `${key}=${escapeField(record[key] ?? "")}`
  );

  return `{${line._tag} ${fields.join(" ")}}`;
};

const readSecret = (text: string): Result.Result<SecretLine, string> => {
  const [kind, ...tokens] = text.slice(1, -1).split(" ");

  if (!isSecretKind(kind)) {
    return Result.fail("not a SecretLine placeholder: an unknown kind");
  }

  const fields = new Map<string, string>([["_tag", kind]]);

  for (const token of tokens) {
    const equals = token.indexOf("=");
    const value = unescapeField(token.slice(equals + 1));

    if (equals <= 0 || value === undefined || fields.has(token.slice(0, equals))) {
      return Result.fail(`not a SecretLine placeholder: a bad field \`${token}\``);
    }

    fields.set(token.slice(0, equals), value);
  }

  const expected = ["_tag", "credential", ...secretFields(kind)].toSorted();

  if ([...fields.keys()].toSorted().join(" ") !== expected.join(" ")) {
    return Result.fail(`a ${kind} placeholder names exactly ${expected.slice(1).join(", ")}`);
  }

  return Result.mapError(decodeSecret(Object.fromEntries(fields)), () => `not a valid ${kind}`);
};

// Instants and durations

const durationPattern = /^(?<amount>\d+)(?<unit>ms|s|m)$/u;
const instantPattern = /^t(?<sign>[+-])(?<amount>\d+)(?<unit>ms|s)$/u;

const unitMillis = new Map([
  ["m", 60_000],
  ["ms", 1],
  ["s", 1000],
]);

/**
 * Writes a span of time, as `13s` or `250ms`.
 * @param millis - Milliseconds, at least 0.
 * @returns The span.
 */
const writeSpan = (millis: number): string =>
  millis % 1000 === 0 ? `${millis / 1000}s` : `${millis}ms`;

/**
 * Writes an instant as its distance from the epoch, such as `t+13s`, so it reads
 * against the transcript's clock.
 * @param instant - Milliseconds since the Unix epoch.
 * @returns The instant, such as `t+13s` or `t-250ms`.
 */
export const writeInstant = (instant: number): string => {
  const offset = instant - epoch;

  return `t${offset < 0 ? "-" : "+"}${writeSpan(Math.abs(offset))}`;
};

const readInstant = (text: string): number | undefined => {
  const groups = instantPattern.exec(text)?.groups;
  const scale = unitMillis.get(groups?.unit ?? "");

  if (groups?.amount === undefined || scale === undefined) {
    return undefined;
  }

  const offset = Number(groups.amount) * scale;

  return epoch + (groups.sign === "-" ? -offset : offset);
};

// Owner inputs

const sayKinds = new Map<string, SayKind>([
  ["action", "Action"],
  ["notice", "Notice"],
  ["say", "Privmsg"],
]);

const sayVerbs: Readonly<Record<SayKind, string>> = {
  Action: "action",
  Notice: "notice",
  Privmsg: "say",
};

const readChanges = (tokens: readonly string[]): Result.Result<readonly Change[], string> => {
  const changes: Change[] = [];

  for (const token of tokens) {
    const last = changes.at(-1);

    if (
      token.length > 4 &&
      token.startsWith("key=") &&
      last?._tag === "Join" &&
      last.key === undefined
    ) {
      changes[changes.length - 1] = { ...last, key: CredentialName.make(token.slice(4)) };
    } else if (token.length > 1 && token.startsWith("+")) {
      changes.push({ _tag: "Join", channel: token.slice(1), key: undefined });
    } else if (token.length > 1 && token.startsWith("-")) {
      changes.push({ _tag: "Part", channel: token.slice(1) });
    } else if (token === "enable" || token === "disable") {
      changes.push({ _tag: token === "enable" ? "Enable" : "Disable" });
    } else if (token.length > 8 && token.startsWith("decline=")) {
      changes.push({ _tag: "Decline", feature: FeatureName.make(token.slice(8)) });
    } else if (token.length > 7 && token.startsWith("accept=")) {
      changes.push({ _tag: "Accept", feature: FeatureName.make(token.slice(7)) });
    } else {
      return Result.fail(`not a change to a Configuration: \`${token}\``);
    }
  }

  return Result.succeed(changes);
};

const writeChange = (change: Change): string => {
  switch (change._tag) {
    case "Join": {
      return change.key === undefined
        ? `+${change.channel}`
        : `+${change.channel} key=${change.key}`;
    }

    case "Part": {
      return `-${change.channel}`;
    }

    case "Enable": {
      return "enable";
    }

    case "Disable": {
      return "disable";
    }

    case "Decline": {
      return `decline=${change.feature}`;
    }

    case "Accept": {
      return `accept=${change.feature}`;
    }

    default: {
      return change satisfies never;
    }
  }
};

const readOwner = (text: string): Result.Result<Owner, string> => {
  if (text === "retry") {
    return Result.succeed({ _tag: "Retry" });
  }

  if (text === "configure" || text.startsWith("configure ")) {
    const tokens = text.split(" ").slice(1);

    return tokens.includes("")
      ? Result.fail("changes are separated by one space")
      : Result.map(readChanges(tokens), (changes) => ({ _tag: "Configure", changes }));
  }

  const verb = text.slice(0, text.indexOf(" "));
  const kind = sayKinds.get(verb);
  const rest = text.slice(verb.length + 1);
  const colon = rest.indexOf(" :");

  if (kind === undefined || colon <= 0 || rest.slice(0, colon).includes(" ")) {
    return Result.fail("not `configure …`, `say|notice|action <target> :<text>`, or `retry`");
  }

  return Result.succeed({
    _tag: "Say",
    kind,
    target: rest.slice(0, colon),
    text: rest.slice(colon + 2),
  });
};

const writeOwner = (owner: Owner): string => {
  switch (owner._tag) {
    case "Configure": {
      return ["configure", ...owner.changes.map(writeChange)].join(" ");
    }

    case "Say": {
      return `${sayVerbs[owner.kind]} ${owner.target} :${owner.text}`;
    }

    case "Retry": {
      return "retry";
    }

    default: {
      return owner satisfies never;
    }
  }
};

// Expectations

const expectations = new Map<string, News["_tag"]>([
  ["activity", "Activity"],
  ["confirmed", "Confirmed"],
  ["connection-failed", "ConnectionFailed"],
  ["ignored", "Ignored"],
  ["message", "Message"],
  ["refused", "Refused"],
  ["session-began", "SessionBegan"],
  ["session-ended", "SessionEnded"],
]);

const readExpect = (text: string): Result.Result<Item, string> => {
  const news = expectations.get(text.split(" ")[0] ?? "");

  return news === undefined
    ? Result.fail(`an expectation starts with one of ${[...expectations.keys()].join(", ")}`)
    : Result.succeed({ _tag: "Expect", news, text });
};

// Items

const dialPattern = /^dial (?<host>[^\s:]+):(?<port>\d{1,5})(?<tls> tls)?$/u;

const isCloseReason = Schema.is(CloseReason);
const isUnfilledReason = Schema.is(UnfilledReason);

// Writes a Line's bytes as text. Plain when they are UTF-8 with no control bytes and no
// trailing space, and a sent Line does not start with `{`; otherwise escaped, marked by
// a `\` after the arrow, with `\\` for a backslash and `\xNN` for any other byte that
// would not survive as text.
const writeBytes = (arrow: "<<" | ">>", bytes: Uint8Array): string => {
  const text = decodeStrict(bytes);

  const plain =
    text !== undefined &&
    !text.includes(bom) &&
    !bytes.some(isControl) &&
    bytes.at(-1) !== space &&
    !(arrow === ">>" && bytes[0] === openBrace);

  return plain ? `${arrow} ${text}` : `${arrow}\\ ${escapeBytes(bytes)}`;
};

const parseArrow = (tag: "Received" | "Sent", rest: string): Result.Result<Item, string> => {
  if (rest.startsWith("\\ ")) {
    const bytes = unescapeBytes(rest.slice(2));

    return bytes === undefined ? Result.fail("a bad escape") : Result.succeed({ _tag: tag, bytes });
  }

  if (!rest.startsWith(" ")) {
    return Result.fail("no space after the arrow");
  }

  const text = rest.slice(1);

  if (tag === "Sent" && text.startsWith("{")) {
    return text.endsWith("}")
      ? Result.map(readSecret(text), (line) => ({ _tag: "SentSecret", line }))
      : Result.fail("a placeholder ends with `}`");
  }

  return Result.succeed({ _tag: tag, bytes: encoder.encode(text) });
};

const parseOutput = (rest: string): Result.Result<Item, string> => {
  if (rest === " hangup") {
    return Result.succeed({ _tag: "Hangup" });
  }

  const dial = dialPattern.exec(rest.slice(1))?.groups;
  const port = Number(dial?.port);

  if (dial?.host === undefined || port < 1 || port > 65_535) {
    return Result.fail("not `-> dial host:port`, `-> dial host:port tls`, or `-> hangup`");
  }

  return Result.succeed({ _tag: "Dial", host: dial.host, port, tls: dial.tls !== undefined });
};

const runtimeHelp =
  "not `== opened`, `== closed <CloseReason>`, `== started`, `== unfilled <UnfilledReason>`, `== fired <timer> t+<n>s`, or `== connection <n>`";

// Each `==` verb, reading its arguments into an item, or `undefined` if they do not fit.
const runtimeVerbs = new Map<string, (args: readonly string[]) => Item | undefined>([
  ["opened", (args) => (args.length === 0 ? { _tag: "Opened" } : undefined)],
  ["started", (args) => (args.length === 0 ? { _tag: "Started" } : undefined)],
  [
    "closed",
    ([reason, ...extra]) =>
      extra.length === 0 && isCloseReason(reason) ? { _tag: "Closed", reason } : undefined,
  ],
  [
    "unfilled",
    ([reason, ...extra]) =>
      extra.length === 0 && isUnfilledReason(reason) ? { _tag: "Unfilled", reason } : undefined,
  ],
  [
    "fired",
    ([timer, due, ...extra]) => {
      const instant = readInstant(due ?? "");

      return extra.length === 0 && timer !== undefined && timer !== "" && instant !== undefined
        ? { _tag: "Fired", due: instant, timer }
        : undefined;
    },
  ],
  [
    "connection",
    ([connection, ...extra]) =>
      extra.length === 0 && /^[1-9]\d*$/u.test(connection ?? "")
        ? { _tag: "Connection", connection: Number(connection) }
        : undefined,
  ],
]);

const parseRuntime = (rest: string): Result.Result<Item, string> => {
  const [verb = "", ...args] = rest.slice(1).split(" ");
  const item = rest.startsWith(" ") ? runtimeVerbs.get(verb)?.(args) : undefined;

  return item === undefined ? Result.fail(runtimeHelp) : Result.succeed(item);
};

const parseText = <A>(
  rest: string,
  what: string,
  read: (text: string) => Result.Result<A, string>
): Result.Result<A, string> =>
  rest.startsWith(" ") && rest.length > 1 ? read(rest.slice(1)) : Result.fail(`an empty ${what}`);

const parseAdvance = (text: string): Result.Result<Item, string> => {
  const groups = durationPattern.exec(text.slice(1))?.groups;
  const scale = unitMillis.get(groups?.unit ?? "");

  if (!text.startsWith("+") || groups?.amount === undefined || scale === undefined) {
    return Result.fail("not a transcript item");
  }

  const millis = Number(groups.amount) * scale;

  return millis > 0 ? Result.succeed({ _tag: "Advance", millis }) : Result.fail("a zero step");
};

const parseItem = (text: string): Result.Result<Item, string> => {
  if (text === "") {
    return Result.succeed({ _tag: "Blank" });
  }

  if (text === "...") {
    return Result.succeed({ _tag: "Any" });
  }

  if (text === "#" || text.startsWith("# ")) {
    return Result.succeed({ _tag: "Comment", text: text.slice(2) });
  }

  const rest = text.slice(2);

  switch (text.slice(0, 2)) {
    case "<<": {
      return parseArrow("Received", rest);
    }

    case ">>": {
      return parseArrow("Sent", rest);
    }

    case "->": {
      return parseOutput(rest);
    }

    case "==": {
      return parseRuntime(rest);
    }

    case "!!": {
      return parseText(rest, "Owner input", (owner) =>
        Result.map(readOwner(owner), (read): Item => ({ _tag: "Owner", owner: read }))
      );
    }

    case "??": {
      return parseText(rest, "expectation", readExpect);
    }

    default: {
      return parseAdvance(text);
    }
  }
};

/**
 * Reads a transcript. Every line must be an item, and the text ends with one newline.
 * @param text - The transcript.
 * @returns Its items, or the first line that is not one.
 */
export const parse = (text: string): Result.Result<readonly Item[], ParseError> => {
  if (text !== "" && !text.endsWith("\n")) {
    return Result.fail({ line: 0, message: "a transcript ends with a newline", text: "" });
  }

  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  const items: Item[] = [];

  for (const [index, line] of lines.entries()) {
    const item = parseItem(line);

    if (Result.isFailure(item)) {
      return Result.fail({ line: index + 1, message: item.failure, text: line });
    }

    items.push(item.success);
  }

  return Result.succeed(items);
};

type RuntimeItem = Extract<
  Item,
  { readonly _tag: "Opened" | "Closed" | "Started" | "Unfilled" | "Fired" | "Connection" }
>;

const printRuntime = (item: RuntimeItem): string => {
  switch (item._tag) {
    case "Opened": {
      return "opened";
    }

    case "Closed": {
      return `closed ${item.reason}`;
    }

    case "Started": {
      return "started";
    }

    case "Unfilled": {
      return `unfilled ${item.reason}`;
    }

    case "Fired": {
      return `fired ${item.timer} ${writeInstant(item.due)}`;
    }

    case "Connection": {
      return `connection ${item.connection}`;
    }

    default: {
      return item satisfies never;
    }
  }
};

/**
 * Writes one item as its line.
 * @param item - The item.
 * @returns Its line, without a newline.
 */
export const printItem = (item: Item): string => {
  switch (item._tag) {
    case "Received": {
      return writeBytes("<<", item.bytes);
    }

    case "Sent": {
      return writeBytes(">>", item.bytes);
    }

    case "SentSecret": {
      return `>> ${writeSecret(item.line)}`;
    }

    case "Dial": {
      return `-> dial ${item.host}:${item.port}${item.tls ? " tls" : ""}`;
    }

    case "Hangup": {
      return "-> hangup";
    }

    case "Owner": {
      return `!! ${writeOwner(item.owner)}`;
    }

    case "Advance": {
      return `+${writeSpan(item.millis)}`;
    }

    case "Expect": {
      return `?? ${item.text}`;
    }

    case "Any": {
      return "...";
    }

    case "Comment": {
      return item.text === "" ? "#" : `# ${item.text}`;
    }

    case "Blank": {
      return "";
    }

    case "Opened":
    case "Closed":
    case "Started":
    case "Unfilled":
    case "Fired":
    case "Connection": {
      return `== ${printRuntime(item)}`;
    }

    default: {
      return item satisfies never;
    }
  }
};

/**
 * Writes a transcript.
 * @param items - The items, in order.
 * @returns The text, each item on its own line, ending with a newline.
 */
export const print = (items: readonly Item[]): string =>
  items.map((item) => `${printItem(item)}\n`).join("");
