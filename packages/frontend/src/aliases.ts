/**
 * Aliases of the Owner's own, as data: a name that stands for one command line, with `$1`
 * to `$9` for the words typed after it and `$*` for all of them, and the edits that add and
 * remove them. An alias expands in one pass, exactly, so what the Owner types never
 * becomes more than what the alias says and the words typed after it: nothing typed is
 * half-expanded, and nothing typed is silently dropped. Whether a name or a line is one a
 * Frontend's commands allow is for `commands.ts`, which holds them.
 *
 * @packageDocumentation
 */
import { aliasesCap } from "@iirc/api/ui";
import type { Alias, AliasLine, AliasName, Aliases } from "@iirc/api/ui";

import type { Parsed } from "./commands.ts";

const parsed = <A>(value: A): Parsed<A> => ({ _tag: "Parsed", value });

const invalid = <A>(message: string): Parsed<A> => ({ _tag: "Invalid", message });

/** A placeholder: `$` and a digit from 1 to 9, `*`, or `$` again, which is one literal `$`. */
const placeholder = /\$(?<which>[1-9*$])/gu;

/**
 * What an alias's line takes: the most words it names, with `$1` to `$9`, or none, and
 * whether it names `$*`. A line that names neither has what is typed after it appended.
 * @param line - The line.
 * @returns What it takes.
 */
export const takes = (line: AliasLine) => {
  let words = 0;
  let all = false;

  for (const match of line.matchAll(placeholder)) {
    const which = match.groups?.which ?? "";

    if (which === "*") {
      all = true;
    } else if (which !== "$") {
      words = Math.max(words, Number(which));
    }
  }

  return { all, words };
};

/**
 * How an alias is typed, from what its line takes: `/name`, then `<1>` for each word it
 * names, then `[…]` for the rest that `$*` or nothing at all would take.
 * @param name - The alias's name.
 * @param line - Its line.
 * @returns The usage.
 */
export const usageOf = (name: AliasName, line: AliasLine): string => {
  const { all, words } = takes(line);

  const named = Array.from({ length: words }, (_, index) => `<${index + 1}>`);
  const rest = all || words === 0 ? ["[…]"] : [];

  return [`/${name}`, ...named, ...rest].join(" ");
};

/**
 * What an alias's line becomes for the text typed after its name, with nothing refused: a
 * word not typed is empty, and words past those named are left out. `expand` refuses
 * either; a Credential is looked for in this, so a line refused for its words is still
 * cleared when what it would carry is one.
 * @param line - The alias's line.
 * @param args - The text after the alias's name.
 * @returns The line, substituted.
 */
export const substituted = (line: AliasLine, args: string): string => {
  const words = args.split(/\s+/u).filter((one) => one !== "");
  const rest = args.trim();
  const { all, words: named } = takes(line);

  const text = line.replaceAll(placeholder, (_match, which: string) => {
    if (which === "$") {
      return "$";
    }

    return which === "*" ? rest : (words[Number(which) - 1] ?? "");
  });

  return named === 0 && !all && rest !== "" ? `${text} ${rest}` : text;
};

/**
 * What an alias's line becomes for the text typed after its name, in one pass: `$1` to
 * `$9` become the words typed, split on whitespace, `$*` all of them with their spacing,
 * and `$$` one `$`, so a `$` before anything else is itself. A line that names no
 * placeholder has what is typed appended after a space, when there is any. What an
 * argument brings in is never read again, so `$2` typed as an argument stays `$2`.
 * @param line - The alias's line.
 * @param args - The text after the alias's name.
 * @returns The line to run, or why there is none: fewer words than the line names, or more
 *   than it takes.
 */
export const expand = (line: AliasLine, args: string): Parsed<string> => {
  const words = args.split(/\s+/u).filter((one) => one !== "");
  const { all, words: named } = takes(line);

  if (words.length < named) {
    return invalid(
      `${line} takes ${named === 1 ? "a word" : `${named} words`}, and ${
        words.length === 0
          ? "none were"
          : `only ${words.length} ${words.length === 1 ? "was" : "were"}`
      } given.`
    );
  }

  if (named > 0 && !all && words.length > named) {
    return invalid(
      `${line} takes ${named === 1 ? "one word" : `${named} words`}, and ${words.length} were given. Nothing is dropped, so $* takes the rest.`
    );
  }

  return parsed(substituted(line, args));
};

/**
 * A change to the aliases, applied to those in force, whatever they are, so it can be
 * applied again after a conflict.
 *
 * - `Add`: an alias, replacing the one with its name.
 * - `Remove`: the alias with this name.
 */
export type AliasesEdit =
  | { readonly _tag: "Add"; readonly alias: Alias }
  | { readonly _tag: "Remove"; readonly name: AliasName };

/**
 * The aliases after an edit, or why it cannot be made: no more than `aliasesCap` are kept,
 * and one that is not there cannot be removed.
 * @param aliases - The aliases.
 * @param edit - The edit.
 * @returns The aliases after.
 */
export const editAliases = (aliases: Aliases, edit: AliasesEdit): Parsed<Aliases> => {
  const name = edit._tag === "Add" ? edit.alias.name : edit.name;
  const at = aliases.findIndex((one) => one.name === name);

  if (edit._tag === "Remove") {
    return at === -1
      ? invalid(`No alias ${name} was made. /alias lists them.`)
      : parsed(aliases.filter((_one, index) => index !== at));
  }

  if (at === -1) {
    return aliases.length >= aliasesCap
      ? invalid(`${aliasesCap} aliases are made already. /alias remove one first.`)
      : parsed([...aliases, edit.alias]);
  }

  return parsed(aliases.map((one, index) => (index === at ? edit.alias : one)));
};
