import { describe, expect, it } from "vitest";

import { channelKey, joinLines } from "./join.ts";
import type { JoinChannel } from "./join.ts";
import { maxLineBytes } from "./outbound.ts";

const decoder = new TextDecoder();

const texts = (channels: readonly JoinChannel[]) =>
  joinLines(channels).lines.map((line) => decoder.decode(line.toBytes()));

const numbered = (count: number, name: (index: number) => string) =>
  Array.from({ length: count }, (_unused, index) => ({ name: name(index) }));

describe(joinLines, () => {
  it("SEND-11: joins nothing for no Channels", () => {
    expect(joinLines([])).toStrictEqual({ lines: [], rejected: [] });
  });

  it("SEND-11: puts Channels on one Line with commas", () => {
    expect(texts([{ name: "#a" }, { name: "#b" }])).toStrictEqual(["JOIN #a,#b"]);
  });

  it("SEND-11: puts keyed Channels first, with keys aligned to them", () => {
    expect(
      texts([{ name: "#open" }, { key: "one", name: "#a" }, { key: "two", name: "#b" }])
    ).toStrictEqual(["JOIN #a,#b,#open one,two"]);
  });

  it("SEND-11: keeps Channels in order within each group", () => {
    expect(
      texts([{ name: "#z" }, { key: "k", name: "#y" }, { name: "#x" }, { key: "l", name: "#w" }])
    ).toStrictEqual(["JOIN #y,#w,#z,#x k,l"]);
  });

  it("SEND-11: treats an empty key as no key, so keys stay aligned", () => {
    expect(
      texts([
        { key: "", name: "#a" },
        { key: "k", name: "#b" },
      ])
    ).toStrictEqual(["JOIN #b,#a k"]);
  });

  it("SEND-11: splits by bytes and fills each Line as far as it will go", () => {
    const lines = texts(numbered(100, (index) => `#channel-with-a-longish-name-${index}`));

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.flatMap((line) => line.slice("JOIN ".length).split(","))).toHaveLength(100);

    for (const line of lines.slice(0, -1)) {
      expect(new TextEncoder().encode(line).length).toBeGreaterThan(maxLineBytes - 40);
    }
  });

  it("SEND-11: counts bytes, not string length", () => {
    const channels = numbered(40, (index) => `#${"é".repeat(9)}${index}`);
    const { lines } = joinLines(channels);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.toBytes().length <= maxLineBytes)).toBeTruthy();
  });

  it("SEND-11: keeps keys aligned on every Line of a long keyed list", () => {
    const channels = Array.from({ length: 60 }, (_unused, index) => ({
      key: `key${index}`,
      name: `#keyed-channel-${index}`,
    }));

    const pairs = texts(channels).flatMap((line) => {
      const [, names = "", keys = ""] = line.split(" ");
      const keyList = keys.split(",");

      return names.split(",").map((name, index) => ({ key: keyList[index], name }));
    });

    expect(pairs).toStrictEqual(channels);
  });

  it("SEND-11: a keyed Line can carry unkeyed Channels after its keys", () => {
    const keyed = Array.from({ length: 3 }, (_unused, index) => ({
      key: `key${index}`,
      name: `#keyed${index}`,
    }));

    expect(texts([{ name: "#open" }, ...keyed])).toStrictEqual([
      "JOIN #keyed0,#keyed1,#keyed2,#open key0,key1,key2",
    ]);
  });

  it("SEND-11: reports a Channel too long for any Line, and sends the rest", () => {
    const giant = { name: `#${"x".repeat(maxLineBytes)}` };
    const { lines, rejected } = joinLines([{ name: "#a" }, giant, { name: "#b" }]);

    expect(lines.map((line) => decoder.decode(line.toBytes()))).toStrictEqual(["JOIN #a,#b"]);
    expect(rejected).toStrictEqual([{ channel: giant, reason: "TooLong" }]);
  });

  it("SEND-11: reports a key that makes its Channel too long", () => {
    const channel = { key: "k".repeat(maxLineBytes), name: "#a" };

    expect(joinLines([channel]).rejected).toStrictEqual([{ channel, reason: "TooLong" }]);
  });

  it("SEND-11: fills a Line to exactly the byte limit", () => {
    const longest = { name: `#${"x".repeat(maxLineBytes - "JOIN #".length)}` };

    expect(joinLines([longest]).rejected).toStrictEqual([]);
    expect(joinLines([{ name: `${longest.name}x` }]).lines).toStrictEqual([]);
  });

  it.each(["", "#a,#b", "#a b", "#a\r\nQUIT", "#a\0", ":#a", "#a\u0007"])(
    "reports %j, which would break the list, rather than sending it",
    (name) => {
      const channel = { name };

      expect(joinLines([channel, { name: "#ok" }])).toMatchObject({
        rejected: [{ channel, reason: "InvalidChannel" }],
      });
      expect(texts([channel, { name: "#ok" }])).toStrictEqual(["JOIN #ok"]);
    }
  );

  it.each(["#", "&local", "+modeless", "!safe"])(
    "CONF-3: takes %j, which starts with a Channel prefix",
    (name) => {
      expect(joinLines([{ name }]).rejected).toStrictEqual([]);
    }
  );

  it.each(["0", "foo", "@op", "0,#a"])(
    "LIVE-7: refuses %j, which no Channel prefix starts, so `JOIN 0` can never leave them all",
    (name) => {
      const channel = { name };

      expect(joinLines([channel])).toStrictEqual({
        lines: [],
        rejected: [{ channel, reason: "InvalidChannel" }],
      });
    }
  );

  it.each(["a,b", "a b", "a\r\nQUIT", "a\0"])("reports the key %j", (key) => {
    const channel = { key, name: "#a" };

    expect(joinLines([channel]).rejected).toStrictEqual([{ channel, reason: "InvalidKey" }]);
  });

  it("SEND-11: a key that starts with a colon stays safe", () => {
    expect(texts([{ key: ":key", name: "#a" }])).toStrictEqual(["JOIN #a ::key"]);
  });
});

describe(channelKey, () => {
  it("lower-cases ASCII alone, so that it can split names but never merge them", () => {
    expect(channelKey("#IIRC-Dev")).toBe("#iirc-dev");
    expect(channelKey("#[Ä]")).toBe("#[Ä]");
  });
});
