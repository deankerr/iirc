import { parseLine } from "./line.ts";
import { outbound } from "./outbound.ts";
import type { Outbound } from "./outbound.ts";

/**
 * A Line of text in which `{{name}}` stands for a value filled in later, such as a
 * connect command that refers to a Credential by name. It is parsed before anything is
 * filled in, so a value can never add a parameter or a command of its own.
 */
export interface Template {
  readonly command: string;
  readonly params: readonly string[];
}

/** Why a template is not one. */
export type TemplateRejection = "NotALine" | "HasPrefix";

// `{{name}}` stands for the value of that name. Compiled once, and `replaceAll` and
// `matchAll` each start it afresh.
const reference = /\{\{(?<name>[^{}]*)\}\}/gu;

/**
 * The names a template refers to, each once, in order.
 * @param template - The template's text.
 * @returns The names, as written between the braces.
 */
export const templateReferences = (template: string): readonly string[] => [
  ...new Set(Array.from(template.matchAll(reference), (match) => match.groups?.name ?? "")),
];

/**
 * Puts a value in place of each reference in some text.
 * @param text - The text.
 * @param fill - The value for a name.
 * @returns The text, filled in.
 */
export const fillReferences = (text: string, fill: (name: string) => string): string =>
  text.replaceAll(reference, (_reference: string, name: string) => fill(name));

/**
 * Parses a template's text as a Line. Tags and a source are refused, because a Line the
 * Daemon sends carries neither, and dropping them quietly would send something other
 * than what was written.
 * @param text - The template's text.
 * @returns The template, or why it is not one.
 */
export const parseTemplate = (
  text: string
):
  | { readonly _tag: "Template"; readonly template: Template }
  | { readonly _tag: "Rejected"; readonly reason: TemplateRejection } => {
  const parsed = parseLine(text);

  if (parsed._tag === "Unparseable") {
    return { _tag: "Rejected", reason: "NotALine" };
  }

  const { command, params, source, tags } = parsed.line;

  return source !== undefined || tags.size > 0
    ? { _tag: "Rejected", reason: "HasPrefix" }
    : { _tag: "Template", template: { command, params } };
};

/**
 * Builds the Line a template stands for, with each reference filled in parameter by
 * parameter, so a value that would break the Line is refused rather than sent.
 * @param template - The parsed template.
 * @param fill - The value for a name.
 * @returns The Line, or why it cannot be built.
 */
export const buildTemplate = (
  { command, params }: Template,
  fill: (name: string) => string
): Outbound =>
  outbound(
    command,
    params.map((param) => fillReferences(param, fill))
  );
