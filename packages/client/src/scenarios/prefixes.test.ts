/**
 * `multi-prefix`: a `NAMES` listing shows every prefix, so a member's prefixes are
 * complete rather than partial, and stale once the cap is deleted.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { Fact } from "../known.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const prefixesOf = (
  transcript: readonly string[],
  nick: string
): Fact<ReadonlySet<string>> | undefined =>
  client
    .known(play(client, { configuration: base, transcript }).state)
    .channels.get("#iirc")
    ?.members.get(nick)?.prefixes;

const isupport = ["CASEMAPPING=rfc1459", "CHANTYPES=#", "PREFIX=(qaohv)~&@%+"];

describe("multi-prefix", () => {
  it("knows every prefix a listing shows", () => {
    const listed = [
      registered(base, { isupport, offered: ["multi-prefix"] }),
      joined(base, "#iirc", ["~&@%+owner", "@+op", "+voiced", "peer"]),
    ];

    expect(prefixesOf(listed, "owner")).toMatchObject({
      _tag: "Known",
      value: new Set(["q", "a", "o", "h", "v"]),
    });
    expect(prefixesOf(listed, "op")).toMatchObject({ _tag: "Known", value: new Set(["o", "v"]) });
    expect(prefixesOf(listed, "voiced")).toMatchObject({ _tag: "Known", value: new Set(["v"]) });
    expect(prefixesOf(listed, "peer")).toMatchObject({ _tag: "Known", value: new Set() });
  });

  it("reads prefixes listed out of rank", () => {
    expect(
      prefixesOf(
        [registered(base, { offered: ["multi-prefix"] }), joined(base, "#iirc", ["+@op"])],
        "op"
      )
    ).toMatchObject({ _tag: "Known", value: new Set(["o", "v"]) });
  });

  it("knows only the highest, as partial, without the cap", () => {
    expect(prefixesOf([registered(base), joined(base, "#iirc", ["@op"])], "op")).toMatchObject({
      _tag: "Partial",
      atLeast: new Set(["o"]),
    });
  });

  it("keeps partial a member shown with a symbol PREFIX does not name", () => {
    const listed = [
      registered(base, { offered: ["multi-prefix"] }),
      joined(base, "#iirc", ["@!odd", "@even"]),
    ];

    expect(prefixesOf(listed, "odd")).toMatchObject({ _tag: "Partial", atLeast: new Set(["o"]) });
    expect(prefixesOf(listed, "even")).toMatchObject({ _tag: "Known", value: new Set(["o"]) });
  });

  it("makes complete prefixes stale on CAP DEL, until a listing says again", () => {
    const deleted = [
      registered(base, { offered: ["cap-notify", "multi-prefix"] }),
      joined(base, "#iirc", ["@+op"]),
      lines("+1s", "<< :irc.test CAP iirc DEL :multi-prefix"),
    ];

    expect(prefixesOf(deleted, "op")).toMatchObject({
      _tag: "Stale",
      was: new Set(["o", "v"]),
    });

    const relisted = [
      ...deleted,
      lines("+1s", "<< :irc.test 353 iirc = #iirc :iirc @op", "<< :irc.test 366 iirc #iirc :End"),
    ];

    expect(prefixesOf(relisted, "op")).toMatchObject({ _tag: "Partial", atLeast: new Set(["o"]) });
  });
});
