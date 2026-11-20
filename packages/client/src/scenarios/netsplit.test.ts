/**
 * A split of the Network, and its healing, as `netsplit` and `netjoin` batches tell them:
 * one Activity in each Channel they touch, while what is known of each Channel's members
 * is exactly what the same Lines would make it unbatched. A batch that is not what its
 * type says is read as its Lines would be without it.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, joined, play, registered, replay } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const inChannels = (...offered: readonly string[]) => [
  registered(base, { offered }),
  joined(base, "#a", ["alice", "bob", "carol"]),
  joined(base, "#b", ["bob", "dave"]),
];

const split = [
  "<< :irc.test BATCH +s1 netsplit hub.test leaf.test",
  "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
  "<< @batch=s1 :bob!u@h QUIT :hub.test leaf.test",
  "<< @batch=s1 :dave!u@h QUIT :hub.test leaf.test",
  "<< :irc.test BATCH -s1",
];

const healed = [
  "<< :irc.test BATCH +j1 netjoin hub.test leaf.test",
  "<< @batch=j1 :alice!u@h JOIN #a",
  "<< @batch=j1 :bob!u@h JOIN #a",
  "<< @batch=j1 :bob!u@h JOIN #b",
  "<< :irc.test BATCH -j1",
];

// The Lines of a transcript with every batch taken away: its `BATCH` Lines and tags.
const unbatched = (rows: readonly string[]): readonly string[] =>
  rows.flatMap((row) => (row.includes(" BATCH ") ? [] : [row.replace(/^<< @batch=\w+ /u, "<< ")]));

// What is known after a transcript, played without matching what it says.
const knownAfter =
  (...offered: readonly string[]) =>
  (rows: readonly string[]) =>
    client.known(
      replay(client, {
        configuration: base,
        transcript: [...inChannels(...offered), lines(...rows)],
      }).state
    );

describe("a netsplit batch", () => {
  it("is one Activity in each Channel it touches, with the servers and who went", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          ...split,
          "?? activity Netsplit #a hub.test leaf.test nicks=alice,bob in=channel:#a",
          "?? activity Netsplit #b hub.test leaf.test nicks=bob,dave in=channel:#b",
          "?? activity Quit alice in=existing-direct:alice :hub.test leaf.test",
          "?? activity Quit bob in=existing-direct:bob :hub.test leaf.test",
          "?? activity Quit dave in=existing-direct:dave :hub.test leaf.test"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("leaves each Channel's members as the Lines would unbatched", () => {
    const after = knownAfter("batch");

    expect(after(split)).toStrictEqual(after(unbatched(split)));
    expect(after([...split, ...healed])).toStrictEqual(after(unbatched([...split, ...healed])));
  });

  it("shows the quit of a User the Owner ignores as it was, apart from the rest", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "!! configure ignores=alice!*@*",
          "...",
          ...split,
          "?? activity Netsplit #a hub.test leaf.test nicks=bob in=channel:#a",
          "?? activity Netsplit #b hub.test leaf.test nicks=bob,dave in=channel:#b",
          '?? activity Quit alice ignored="alice!*@*" in=channel:#a in=existing-direct:alice :hub.test leaf.test',
          "?? activity Quit bob in=existing-direct:bob :hub.test leaf.test",
          "?? activity Quit dave in=existing-direct:dave :hub.test leaf.test"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a netjoin batch", () => {
  it("is one Activity in each Channel it touches, with the servers and who came back", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          ...split,
          "...",
          "?? activity Quit dave in=existing-direct:dave :hub.test leaf.test",
          ...healed,
          "?? activity Netjoin #a hub.test leaf.test nicks=alice,bob in=channel:#a",
          "?? activity Netjoin #b hub.test leaf.test nicks=bob in=channel:#b"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("without batch", () => {
  it("reads the Lines of a split one by one, as an Ircd sends them unbatched", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels(),
        lines(
          "<< :alice!u@h QUIT :hub.test leaf.test",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "<< :bob!u@h QUIT :hub.test leaf.test",
          "?? activity Quit bob in=channel:#a in=channel:#b in=existing-direct:bob :hub.test leaf.test"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("a batch that is not what its type says", () => {
  it.each([
    ["names one server", "BATCH +s1 netsplit hub.test"],
    ["names three", "BATCH +s1 netsplit hub.test leaf.test other.test"],
    ["names an empty one", "BATCH +s1 netsplit hub.test :"],
  ])("%s, and is read as its Lines would be unbatched", (_name, opening) => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          `<< :irc.test ${opening}`,
          "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "<< :irc.test BATCH -s1"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("holds a Line of another kind, and gives back what it held, in order", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "<< :irc.test BATCH +s1 netsplit hub.test leaf.test",
          "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
          "<< @batch=s1 :bob!u@h PART #b",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "?? activity Parted #b bob in=channel:#b",
          "<< @batch=s1 :carol!u@h QUIT :hub.test leaf.test",
          "?? activity Quit carol in=channel:#a in=existing-direct:carol :hub.test leaf.test",
          "<< :irc.test BATCH -s1"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("holds a JOIN in a netsplit, or a QUIT in a netjoin, and is read unbatched", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "<< :irc.test BATCH +j1 netjoin hub.test leaf.test",
          "<< @batch=j1 :erin!u@h JOIN #a",
          "<< @batch=j1 :alice!u@h QUIT :hub.test leaf.test",
          "?? activity Joined #a erin in=channel:#a",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "<< :irc.test BATCH -j1"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is opened inside another, and is read unbatched", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "<< :irc.test BATCH +outer example.test/other",
          "<< @batch=outer :irc.test BATCH +s1 netsplit hub.test leaf.test",
          "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "<< @batch=outer :irc.test BATCH -s1",
          "<< :irc.test BATCH -outer"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("has another opened inside it, and gives back what it held", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "<< :irc.test BATCH +s1 netsplit hub.test leaf.test",
          "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
          "<< @batch=s1 :irc.test BATCH +inner example.test/other",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "<< @batch=s1 :bob!u@h QUIT :hub.test leaf.test",
          "?? activity Quit bob in=channel:#a in=channel:#b in=existing-direct:bob :hub.test leaf.test",
          "<< :irc.test BATCH -s1"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("names Self, and gives back what it held", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "<< :irc.test BATCH +j1 netjoin hub.test leaf.test",
          "<< @batch=j1 :erin!u@h JOIN #a",
          "<< @batch=j1 :iirc!u@h JOIN #c",
          "?? activity Joined #a erin in=channel:#a",
          "?? activity Joined #c iirc in=channel:#c",
          "...",
          "<< :irc.test BATCH -j1"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("never ends before its Connection does, and gives back what it held then", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("batch"),
        lines(
          "<< :irc.test BATCH +s1 netsplit hub.test leaf.test",
          "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
          "== closed Reset",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "..."
        ),
      ],
    });

    expect.assertions(0);
  });

  it("outlives the batch cap, and gives back what it held when the cap goes", () => {
    play(client, {
      configuration: base,
      transcript: [
        ...inChannels("cap-notify", "batch"),
        lines(
          "<< :irc.test BATCH +s1 netsplit hub.test leaf.test",
          "<< @batch=s1 :alice!u@h QUIT :hub.test leaf.test",
          "<< :irc.test CAP iirc DEL :batch",
          "?? activity Quit alice in=channel:#a in=existing-direct:alice :hub.test leaf.test",
          "..."
        ),
      ],
    });

    expect.assertions(0);
  });
});
