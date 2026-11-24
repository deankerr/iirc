import { aliasesCap } from "@iirc/api/ui";
import { describe, expect, it } from "vitest";

import { editAliases, expand, usageOf } from "./aliases.ts";

/**
 * What a line expands to, or `refused` when it does not.
 * @param line - The alias's line.
 * @param args - The text after its name.
 * @returns The line to run, or `refused`.
 */
const expanded = (line: string, args: string) => {
  const result = expand(line, args);

  return result._tag === "Parsed" ? result.value : "refused";
};

describe("expanding an alias", () => {
  it.each([
    // $1 to $9 are the words typed, split on any whitespace, in any order and any number of times.
    ["/x $2 $1", "a b", "/x b a"],
    ["/x $1|$2", " a \t b ", "/x a|b"],
    ["/x $1 $1", "a", "/x a a"],
    ["/x $9", "a b c d e f g h i", "/x i"],
    // $* is everything typed, trimmed, its spacing inside kept.
    ["/x $*", "  a   b  ", "/x a   b"],
    ["/x $1: $*", "a b  c", "/x a: a b  c"],
    ["/x $*", "", "/x "],
    // $$ is a $, and a $ before anything else is itself.
    ["/x $$1", "", "/x $1"],
    ["/x $$*", "", "/x $*"],
    ["/x $ $a $", "", "/x $ $a $"],
    ["/x $1 $$", "a", "/x a $"],
    // A line that names nothing has what is typed appended.
    ["/join", "#a", "/join #a"],
    ["/me", "  waves  hello ", "/me waves  hello"],
    ["/join #a", "", "/join #a"],
    ["/x $$1", "a", "/x $1 a"],
    // Nothing typed is half-expanded or dropped.
    ["/x $1 $2", "a", "refused"],
    ["/x $1", "", "refused"],
    ["/x $3", "a b", "refused"],
    ["/x $1", "a b", "refused"],
    ["/x $2 $1", "a b c", "refused"],
    ["/x $1 $*", "a b c", "/x a a b c"],
    // What an argument brings in is never read again.
    ["/x $1", "$2", "/x $2"],
    ["/x $1 $2", "$2 $*", "/x $2 $*"],
    ["/x $*", "$1 $$", "/x $1 $$"],
    ["/x", "$1", "/x $1"],
  ])("takes %s given %j as %j", (line, args, expected) => {
    expect(expanded(line, args)).toBe(expected);
  });

  it("says how many words a line takes, and shows the line, when it is refused", () => {
    expect([expand("/x $1 $2", "a"), expand("/x $1", "a b")]).toStrictEqual([
      { _tag: "Invalid", message: "/x $1 $2 takes 2 words, and only 1 was given." },
      {
        _tag: "Invalid",
        message: "/x $1 takes one word, and you gave 2. Nothing is dropped, so $* takes the rest.",
      },
    ]);
  });

  it("says how an alias is typed, by what its line takes", () => {
    expect([
      usageOf("j", "/join"),
      usageOf("j", "/join $1"),
      usageOf("m", "/msg $1 $2"),
      usageOf("s", "/say $*"),
      usageOf("s", "/msg $1 $*"),
    ]).toStrictEqual(["/j […]", "/j <1>", "/m <1> <2>", "/s […]", "/s <1> […]"]);
  });
});

describe("editing the aliases", () => {
  const join = { line: "/join $1", name: "j" };
  const part = { line: "/part $1", name: "p" };
  const full = Array.from({ length: aliasesCap }, (_, index) => ({ ...join, name: `a${index}` }));

  it("adds, replaces in place, refuses past the cap, and removes, saying when one is not there", () => {
    expect({
      added: editAliases([join], { _tag: "Add", alias: part }),
      cap: editAliases(full, { _tag: "Add", alias: join }),
      capReplace: editAliases(full, { _tag: "Add", alias: { ...join, name: "a3" } })._tag,
      missing: editAliases([join], { _tag: "Remove", name: "p" }),
      removed: editAliases([join, part], { _tag: "Remove", name: "j" }),
      replaced: editAliases([join, part], { _tag: "Add", alias: { ...join, line: "/part $1" } }),
    }).toStrictEqual({
      added: { _tag: "Parsed", value: [join, part] },
      cap: {
        _tag: "Invalid",
        message: "You already have 64 aliases. /alias remove one first.",
      },
      capReplace: "Parsed",
      missing: { _tag: "Invalid", message: "You have no alias p. /alias lists them." },
      removed: { _tag: "Parsed", value: [part] },
      replaced: { _tag: "Parsed", value: [{ line: "/part $1", name: "j" }, part] },
    });
  });
});
