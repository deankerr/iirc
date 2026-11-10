/**
 * `channel`: one Channel as Knowledge knows it, built from that Channel alone.
 */
import { describe, expect, it } from "vitest";

import { client } from "./core.ts";
import { configured, joined, play, registered } from "./testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const isupport = ["CASEMAPPING=rfc1459", "CHANTYPES=#", "PREFIX=(qov)~@+"];

const transcript = [
  registered(base, { isupport, offered: ["multi-prefix", "away-notify"] }),
  joined(base, "#iirc", ["~@owner", "+Voiced", "peer"]),
  joined(base, "#other", ["elsewhere", "peer"]),
  lines(
    "<< :peer!u@h AWAY :gone fishing",
    "?? activity AwayChanged peer in=existing-direct:peer :gone fishing",
    "<< :irc.test 332 iirc #iirc :the topic"
  ),
];

const { state } = play(client, { configuration: base, transcript });

describe("channel", () => {
  it("gives what Knowledge knows of one Channel, and of its members as Users", () => {
    const knowledge = client.known(state);
    const view = client.channel(state, "#iirc");
    const members = knowledge.channels.get("#iirc")?.members;

    expect(view?.key).toBe("#iirc");
    expect(view?.channel).toStrictEqual(knowledge.channels.get("#iirc"));
    expect(view?.casemapping).toBe("rfc1459");
    expect(view?.users).toStrictEqual(
      new Map([...(members?.keys() ?? [])].map((key) => [key, knowledge.users.get(key)]))
    );
    expect([view?.users.get("peer")?.away, view?.users.get("elsewhere")]).toMatchObject([
      { _tag: "Known", value: { message: "gone fishing" } },
      undefined,
    ]);
  });

  it("gives the membership prefixes in the order of PREFIX", () => {
    expect(client.channel(state, "#iirc")?.ranks).toStrictEqual([
      { mode: "q", symbol: "~" },
      { mode: "o", symbol: "@" },
      { mode: "v", symbol: "+" },
    ]);
  });

  it("finds a Channel by any spelling the Connection's casemapping folds alike", () => {
    expect(client.channel(state, "#IIRC")?.key).toBe("#iirc");
    expect(client.channel(state, "#nowhere")).toBeUndefined();
  });

  it("gives a Channel the Owner wants and Self is not yet in, with no members", () => {
    const wanting = play(client, {
      configuration: base,
      transcript: [registered(base), lines("!! configure +#later", ">> JOIN #later")],
    }).state;

    expect(client.channel(wanting, "#later")).toMatchObject({
      channel: { members: new Map(), standing: "Joining", topic: { _tag: "Unknown" } },
      users: new Map(),
    });
  });
});
