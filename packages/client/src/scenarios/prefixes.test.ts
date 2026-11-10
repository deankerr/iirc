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

describe("multi-prefix, once deleted", () => {
  const deleted = [
    registered(base, { offered: ["cap-notify", "multi-prefix"] }),
    joined(base, "#iirc", ["@+op", "peer"]),
    lines("+1s", "<< :irc.test CAP iirc DEL :multi-prefix", "+1s"),
  ];

  it("makes a MODE on prefixes it made complete give what the floor would: partial", () => {
    expect(prefixesOf([...deleted, lines("<< :op!u@h MODE #iirc -v op")], "op")).toMatchObject({
      _tag: "Partial",
      atLeast: new Set(["o"]),
    });
  });

  it("keeps them known through a MODE while it is on", () => {
    expect(
      prefixesOf(
        [
          registered(base, { offered: ["multi-prefix"] }),
          joined(base, "#iirc", ["@+op"]),
          lines("<< :op!u@h MODE #iirc -v op"),
        ],
        "op"
      )
    ).toMatchObject({ _tag: "Known", value: new Set(["o"]) });
  });

  it("leaves alone what the floor knew in full: a member listed with no prefix", () => {
    expect(prefixesOf(deleted, "peer")).toMatchObject({ _tag: "Known", value: new Set() });
    expect(prefixesOf([...deleted, lines("<< :op!u@h MODE #iirc +v peer")], "peer")).toMatchObject({
      _tag: "Known",
      value: new Set(["v"]),
    });
  });
});

describe("completed prefixes, with inputs at one instant", () => {
  const start = [
    registered(base, { offered: ["cap-notify", "multi-prefix"] }),
    joined(base, "#iirc", ["@+op"]),
  ];

  it("are known again when the cap comes back and a listing says them, at the same instant", () => {
    expect(
      prefixesOf(
        [
          ...start,
          lines(
            "<< :irc.test CAP iirc DEL :multi-prefix",
            "<< :irc.test CAP iirc NEW :multi-prefix",
            ">> CAP REQ multi-prefix",
            "<< :irc.test CAP iirc ACK :multi-prefix",
            "<< :irc.test 353 iirc = #iirc :iirc @+op",
            "<< :irc.test 366 iirc #iirc :End"
          ),
        ],
        "op"
      )
    ).toMatchObject({ _tag: "Known", value: new Set(["o", "v"]) });
  });

  it("stay stale through the cap coming back, until something says them again", () => {
    expect(
      prefixesOf(
        [
          ...start,
          lines(
            "<< :irc.test CAP iirc DEL :multi-prefix",
            "<< :irc.test CAP iirc NEW :multi-prefix",
            ">> CAP REQ multi-prefix",
            "<< :irc.test CAP iirc ACK :multi-prefix"
          ),
        ],
        "op"
      )
    ).toMatchObject({ _tag: "Stale", was: new Set(["o", "v"]) });
  });

  it("are partial after a MODE at the same instant as the CAP DEL", () => {
    expect(
      prefixesOf(
        [...start, lines("<< :irc.test CAP iirc DEL :multi-prefix", "<< :op!u@h MODE #iirc -v op")],
        "op"
      )
    ).toMatchObject({ _tag: "Partial", atLeast: new Set(["o"]) });
  });
});

describe("a PREFIX that repeats a mode or a symbol", () => {
  // `(oov)@%+` names `o` twice, so no rank is clear. The protocol's default `(ov)@+` holds,
  // and `%`, which only the malformed value named, is a prefix that cannot be named.
  const listed = [
    registered(base, {
      isupport: ["CASEMAPPING=rfc1459", "CHANTYPES=#", "PREFIX=(oov)@%+"],
      offered: ["multi-prefix"],
    }),
    joined(base, "#iirc", ["@op", "%half", "+voiced"]),
  ];

  it("reads the members by the default PREFIX", () => {
    const { state } = play(client, { configuration: base, transcript: listed });

    expect([
      prefixesOf(listed, "op"),
      prefixesOf(listed, "half"),
      prefixesOf(listed, "voiced"),
      client.channel(state, "#iirc")?.ranks,
    ]).toMatchObject([
      { _tag: "Known", value: new Set(["o"]) },
      { _tag: "Partial", atLeast: new Set() },
      { _tag: "Known", value: new Set(["v"]) },
      [
        { mode: "o", symbol: "@" },
        { mode: "v", symbol: "+" },
      ],
    ]);
  });
});
