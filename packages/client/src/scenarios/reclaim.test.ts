/**
 * Taking a nick back: Self settled for the second nick it offered, and asks for the first
 * once it sees the holder leave it.
 */
import type { Param } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, joined, play } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured({ nicks: ["iirc", "other"] });

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const isupport = floorIsupport.join(" ");

// `iirc` is taken as Self registers, so Self settles for `other`.
const settledFor = (nick: string) =>
  lines(
    "!! configure",
    "-> dial irc.test:6697 tls",
    "== opened",
    ">> CAP LS 302",
    ">> NICK iirc",
    ">> USER iirc 0 * iirc",
    "<< :irc.test 421 * CAP :Unknown command",
    "<< :irc.test 433 * iirc :Nickname is already in use",
    `>> NICK ${nick}`,
    `<< :irc.test 001 ${nick} :Welcome ${nick}`,
    `<< :irc.test 005 ${nick} ${isupport} :are supported by this server`
  );

// Self joins `#iirc`, where the holder of `iirc` and a bystander are.
const inChannel = [
  settledFor("other"),
  joined(base, "#iirc", ["iirc", "bystander"], { nick: "other" }),
];

const played = (...rest: readonly string[]) =>
  play(client, { configuration: base, transcript: [...inChannel, ...rest] });

// Every `NICK` the Client sent, after registration's own two.
const asks = (run: Played<State>): readonly (readonly Param[])[] =>
  run.steps
    .flatMap((step) => step.outputs)
    .flatMap((output) =>
      output._tag === "Send" && output.line.command === "NICK" ? [output.line.params] : []
    )
    .slice(2);

const refusals = (run: Played<State>) =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "Refused"));

const selfNick = (run: Played<State>) => client.known(run.state).self?.nick;

describe("taking a nick back", () => {
  it("asks for the preferred nick once its holder quits", () => {
    const run = played(lines("<< :iirc!u@h QUIT :gone", ">> NICK iirc"));

    expect(asks(run)).toStrictEqual([["iirc"]]);
  });

  it("asks for the preferred nick once its holder renames", () => {
    const run = played(lines("<< :iirc!u@h NICK elsewhere", ">> NICK iirc"));

    expect(asks(run)).toStrictEqual([["iirc"]]);
  });

  it("does not ask when a User other than the holder quits or renames", () => {
    const run = played(lines("<< :bystander!u@h NICK somebody", "<< :somebody!u@h QUIT :gone"));

    expect(asks(run)).toStrictEqual([]);
  });

  it("does not ask when the holder only changes the case of the nick", () => {
    const run = played(lines("<< :iirc!u@h NICK IIRC"));

    expect(asks(run)).toStrictEqual([]);
  });

  it("asks by the Connection's casemapping, so `{` is `[`", () => {
    const run = play(client, {
      configuration: configured({ nicks: ["i[rc", "other"] }),
      transcript: [
        settledFor("other").replaceAll(/(?<verb>NICK |433 \* )iirc/gu, "$<verb>i[rc"),
        lines("<< :i{rc!u@h QUIT :gone", ">> NICK i[rc"),
      ],
    });

    expect(asks(run)).toStrictEqual([["i[rc"]]);
  });

  it("takes the nick, and Self's nick changes like any other change of it", () => {
    const run = played(
      lines(
        "<< :iirc!u@h QUIT :gone",
        ">> NICK iirc",
        "<< :other!~iirc@iirc.test NICK :iirc",
        "?? activity NickChanged other iirc in=network in=channel:#iirc"
      ),
      lines("<< :bystander!u@h QUIT :gone")
    );

    expect(selfNick(run)).toBe("iirc");
    expect(asks(run)).toStrictEqual([["iirc"]]);
  });

  it("does not retry a refusal, and asks again when the holder is seen to leave again", () => {
    const run = played(
      lines(
        "<< :iirc!u@h QUIT :gone",
        ">> NICK iirc",
        "<< :irc.test 433 other iirc :Nickname is already in use",
        "+30s"
      ),
      lines(
        "<< :newcomer!u@h JOIN #iirc",
        "<< :newcomer!u@h NICK iirc",
        "<< :iirc!u@h QUIT :gone",
        ">> NICK iirc"
      )
    );

    expect(selfNick(run)).toBe("other");
    expect(asks(run)).toStrictEqual([["iirc"], ["iirc"]]);
  });

  it("never changes a nick the Owner chose with `/nick`", () => {
    const run = played(
      lines(
        "!! nick mine",
        ">> NICK mine",
        "<< :other!~iirc@iirc.test NICK mine",
        "<< :iirc!u@h QUIT :gone"
      )
    );

    expect(selfNick(run)).toBe("mine");
    expect(asks(run)).toStrictEqual([["mine"]]);
  });

  it("never changes a nick the Owner chose with a raw `NICK`", () => {
    const run = played(
      lines(
        "!! quote nick mine",
        ">> NICK mine",
        "<< :other!~iirc@iirc.test NICK mine",
        "<< :iirc!u@h NICK elsewhere"
      )
    );

    expect(selfNick(run)).toBe("mine");
    expect(asks(run)).toStrictEqual([["mine"]]);
  });

  it("lets the next Session settle again, and take the nick back in it", () => {
    const run = played(
      lines(
        "!! nick mine",
        ">> NICK mine",
        "<< :other!~iirc@iirc.test NICK mine",
        "== closed Reset",
        "+2s",
        "-> dial irc.test:6697 tls",
        "== opened",
        ">> CAP LS 302",
        ">> NICK iirc",
        ">> USER iirc 0 * iirc",
        "<< :irc.test 433 * iirc :Nickname is already in use",
        ">> NICK other",
        "<< :irc.test 001 other :Welcome other",
        ">> JOIN #iirc",
        "<< :other!u@h JOIN #iirc",
        ">> MODE #iirc",
        "<< :irc.test 353 other = #iirc :other iirc",
        "<< :irc.test 366 other #iirc :End of /NAMES list.",
        "<< :iirc!u@h QUIT :gone",
        ">> NICK iirc"
      )
    );

    // The second Session's registration offered `iirc`, then `other`, before the ask.
    expect(asks(run)).toStrictEqual([["mine"], ["iirc"], ["other"], ["iirc"]]);
  });

  it("does not ask when Self registered with the preferred nick", () => {
    const run = play(client, {
      configuration: base,
      transcript: [
        lines(
          "!! configure",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test 421 * CAP :Unknown command",
          "<< :irc.test 001 iirc :Welcome iirc",
          `<< :irc.test 005 iirc ${isupport} :are supported by this server`
        ),
        joined(base, "#iirc", ["peer"]),
        lines("<< :peer!u@h QUIT :gone", "<< :peer!u@h NICK iirc"),
      ],
    });

    expect(asks(run)).toStrictEqual([]);
  });

  it("sets no timer, so nothing polls", () => {
    const before = played();
    const after = played(lines("<< :iirc!u@h QUIT :gone", ">> NICK iirc"));

    expect(after.timers).toStrictEqual(before.timers);
    expect(after.steps.at(-1)?.outputs.map((output) => output._tag)).toStrictEqual(["Send"]);
  });

  describe("while the Owner sends a `NICK` of their own", () => {
    const asked = lines("<< :iirc!u@h QUIT :gone", ">> NICK iirc", "!! nick iirc", ">> NICK iirc");

    it("answers a refusal to the ask, and a second to the Owner's line", () => {
      const run = played(asked, lines("<< :irc.test 433 other iirc :Nickname is already in use"));

      expect(refusals(run)).toStrictEqual([]);

      const second = played(
        asked,
        lines(
          "<< :irc.test 433 other iirc :Nickname is already in use",
          "<< :irc.test 433 other iirc :Nickname is already in use",
          "?? refused i1 Rejected 433 nick=iirc in=network"
        )
      );

      expect(refusals(second)).toHaveLength(1);
    });

    it("answers a success to the ask, and leaves the Owner's line awaited", () => {
      const run = played(
        asked,
        lines(
          "<< :other!u@h NICK :iirc",
          "<< :irc.test 433 iirc iirc :Nickname is already in use",
          "?? refused i1 Rejected 433 nick=iirc in=network"
        )
      );

      expect(selfNick(run)).toBe("iirc");
      expect(refusals(run)).toHaveLength(1);
    });
  });

  describe("when the Ircd answers the ask with a standard reply", () => {
    const failed = lines(
      "<< :iirc!u@h QUIT :gone",
      ">> NICK iirc",
      "<< :irc.test FAIL NICK NICKNAME_IN_USE iirc :Nickname is already in use"
    );

    it("settles no intent for a FAIL, and shows it in the Network's own Timeline", () => {
      const run = played(failed);

      const shown = run.steps
        .flatMap((step) => step.news)
        .filter((news) => news._tag === "Activity");

      expect(
        run.steps.flatMap((step) => step.news).filter((news) => news._tag === "Refused")
      ).toStrictEqual([]);
      expect(shown.at(-1)).toMatchObject({
        activity: { _tag: "StandardReply", command: "NICK", kind: "FAIL" },
        where: [{ _tag: "Network" }],
      });
    });

    it("goes to the ask and not to the Owner's line sent after it", () => {
      const run = played(
        lines(
          "<< :iirc!u@h QUIT :gone",
          ">> NICK iirc",
          "!! nick iirc",
          ">> NICK iirc",
          "<< :irc.test FAIL NICK NICKNAME_IN_USE iirc :Nickname is already in use",
          "<< :irc.test 433 other iirc :Nickname is already in use",
          "?? refused i1 Rejected 433 nick=iirc in=network"
        )
      );

      expect(refusals(run)).toHaveLength(1);
    });

    it("takes a 438 as a refusal of the ask, so a later numeric is the Owner's", () => {
      const run = played(
        lines(
          "<< :iirc!u@h QUIT :gone",
          ">> NICK iirc",
          "<< :irc.test 438 other iirc :Nick change too fast",
          "!! nick iirc",
          ">> NICK iirc",
          "<< :irc.test 433 other iirc :Nickname is already in use",
          "?? refused i1 Rejected 433 nick=iirc in=network"
        )
      );

      expect(refusals(run)).toHaveLength(1);
      expect(selfNick(run)).toBe("other");
    });

    it("refuses the Owner's own NICK with a 438", () => {
      const run = played(
        lines(
          "!! nick iirc",
          ">> NICK iirc",
          "<< :irc.test 438 other iirc :Nick change too fast",
          "?? refused i1 Rejected 438 nick=iirc in=network"
        )
      );

      expect(refusals(run)).toHaveLength(1);
    });

    it("forgets the ask, so a later numeric is the Owner's", () => {
      const run = played(
        failed,
        lines(
          "!! nick iirc",
          ">> NICK iirc",
          "<< :irc.test 433 other iirc :Nickname is already in use",
          "?? refused i1 Rejected 433 nick=iirc in=network"
        )
      );

      expect(selfNick(run)).toBe("other");
    });
  });
});
