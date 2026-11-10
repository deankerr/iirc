/**
 * `batch`: open batches tracked by reference, so a Line in one carries it on. The
 * Feature itself changes nothing a View sees, so these scenarios add a Feature of their
 * own after it that treats every Line in a batch as history, as `chathistory` will. That
 * also shows the core's rule: history is reported, and never changes what is known now.
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature } from "../feature.ts";
import { maxOpen } from "../features/batch.ts";
import { FeatureName } from "../ids.ts";
import { register, registry } from "../registry.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// Every Line the batch Feature says is in a batch is history.
const history: Feature = {
  label: (arrival) => ({
    value: arrival.batch === undefined ? arrival : { ...arrival, live: false },
  }),
  name: FeatureName.make("history"),
  needs: {},
  own: undefined,
};

const withHistory = makeClient([...registry, register(history)]);

const inChannel = (...offered: readonly string[]) => [
  registered(base, { offered }),
  joined(base, "#iirc", ["@op", "peer"]),
];

describe("batches", () => {
  it("carries a batch on to the Lines in it, and none once it closes", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< :irc.test BATCH +b1 example.com/unknown-type a b",
          "<< @batch=b1 :peer!u@h PRIVMSG #iirc :in it",
          "?? message Privmsg peer #iirc history in=channel:#iirc :in it",
          "<< :peer!u@h PRIVMSG #iirc :not in it",
          "?? message Privmsg peer #iirc in=channel:#iirc :not in it",
          "<< :irc.test BATCH -b1",
          "<< @batch=b1 :peer!u@h PRIVMSG #iirc :after it",
          "?? message Privmsg peer #iirc in=channel:#iirc :after it"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("nests a batch inside another, and closes both, inside first or out", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< :irc.test BATCH +outer example.com/foo",
          "<< @batch=outer :irc.test BATCH +inner example.com/bar",
          "<< @batch=inner :peer!u@h PRIVMSG #iirc :inner",
          "?? message Privmsg peer #iirc history in=channel:#iirc :inner",
          "<< @batch=outer :irc.test BATCH -inner",
          "<< @batch=inner :peer!u@h PRIVMSG #iirc :inner closed",
          "?? message Privmsg peer #iirc in=channel:#iirc :inner closed",
          "<< @batch=outer :peer!u@h PRIVMSG #iirc :outer",
          "?? message Privmsg peer #iirc history in=channel:#iirc :outer",
          "<< @batch=outer :irc.test BATCH +left example.com/bar",
          "<< :irc.test BATCH -outer",
          "<< @batch=left :peer!u@h PRIVMSG #iirc :closed with its outer",
          "?? message Privmsg peer #iirc in=channel:#iirc :closed with its outer"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("interleaves batches", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< :irc.test BATCH +1 example.com/foo",
          "<< :irc.test BATCH +2 example.com/foo",
          "<< @batch=1 :peer!u@h PRIVMSG #iirc :one",
          "?? message Privmsg peer #iirc history in=channel:#iirc :one",
          "<< :irc.test BATCH -1",
          "<< @batch=2 :peer!u@h PRIVMSG #iirc :two",
          "?? message Privmsg peer #iirc history in=channel:#iirc :two",
          "<< :irc.test BATCH -2"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("carries no batch it was not told of, or one opened with no type", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< @batch=nope :peer!u@h PRIVMSG #iirc :unknown",
          "?? message Privmsg peer #iirc in=channel:#iirc :unknown",
          "<< :irc.test BATCH +typeless",
          "<< @batch=typeless :peer!u@h PRIVMSG #iirc :typeless",
          "?? message Privmsg peer #iirc in=channel:#iirc :typeless",
          "<< :irc.test BATCH +",
          "<< :irc.test BATCH -never-opened",
          "<< :irc.test BATCH"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("keeps at most a bounded number open, and drops them when the Connection ends", () => {
    const opening = Array.from(
      { length: maxOpen + 1 },
      (_unused, index) => `<< :irc.test BATCH +b${index} netsplit`
    );

    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          ...opening,
          `<< @batch=b${maxOpen - 1} :peer!u@h PRIVMSG #iirc :last kept`,
          "?? message Privmsg peer #iirc history in=channel:#iirc :last kept",
          `<< @batch=b${maxOpen} :peer!u@h PRIVMSG #iirc :one too many`,
          "?? message Privmsg peer #iirc in=channel:#iirc :one too many",
          "== closed Reset",
          "?? session-ended Closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc",
          "<< :irc.test CAP * LS :batch",
          ">> CAP REQ batch",
          "<< :irc.test CAP * ACK :batch",
          ">> CAP END",
          "<< :irc.test 001 iirc :Welcome",
          ">> JOIN #iirc",
          "<< @batch=b0 :peer!u@h PRIVMSG iirc :from the last Connection",
          "?? message Privmsg peer iirc in=direct:peer :from the last Connection"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("carries no batch without the cap", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel(),
        lines(
          "<< :irc.test BATCH +b1 netsplit",
          "<< @batch=b1 :peer!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg peer #iirc in=channel:#iirc :hi"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("reads each Line of a batch as it comes, whatever its type", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< :irc.test BATCH +split netsplit irc.hub other.host",
          "<< @batch=split :peer!u@h QUIT :irc.hub other.host",
          "?? activity Quit peer in=channel:#iirc in=existing-direct:peer :irc.hub other.host"
        ),
      ],
    });

    expect([
      ...(client.known(played.state).channels.get("#iirc")?.members.keys() ?? []),
    ]).toStrictEqual(["iirc", "op"]);
  });

  it("carries no batch after the cap is deleted mid-batch", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("cap-notify", "batch"),
        lines(
          "<< :irc.test BATCH +b1 netsplit",
          "<< @batch=b1 :peer!u@h PRIVMSG #iirc :in it",
          "?? message Privmsg peer #iirc history in=channel:#iirc :in it",
          "<< :irc.test CAP iirc DEL :batch",
          "<< @batch=b1 :peer!u@h PRIVMSG #iirc :after DEL",
          "?? message Privmsg peer #iirc in=channel:#iirc :after DEL",
          "<< :irc.test BATCH -b1"
        ),
      ],
    });

    expect.assertions(0);
  });
});

describe("history", () => {
  it("never renames a Direct Message Timeline, so a nick someone new took keeps theirs", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< :peer!u@h PRIVMSG iirc :psst",
          "?? message Privmsg peer iirc in=direct:peer :psst",
          "<< :peer!u@h NICK pal",
          "?? activity NickChanged peer pal in=channel:#iirc in=renamed:peer>pal",
          // Someone new has the nick `peer`, and starts a Timeline of their own.
          "<< :peer!v@elsewhere PRIVMSG iirc :I am new",
          "?? message Privmsg peer iirc in=direct:peer :I am new",
          // The first rename, told again from history, is shown where `peer` talked and
          // moves nothing: `peer` is not `pal` now.
          "<< :irc.test BATCH +h chathistory iirc",
          "<< @batch=h :peer!u@h NICK pal",
          "?? activity NickChanged peer pal history in=existing-direct:peer",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("is reported, and never changes membership, nicks, topics, or modes", () => {
    const now = play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines(
          "<< :irc.test 332 iirc #iirc :the topic",
          "<< :irc.test 324 iirc #iirc +nt",
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h :new!u@h JOIN #iirc",
          "?? activity Joined #iirc new history in=channel:#iirc",
          "<< @batch=h :peer!u@h PART #iirc :gone",
          "?? activity Parted #iirc peer history in=channel:#iirc :gone",
          "<< @batch=h :op!u@h NICK renamed",
          "?? activity NickChanged op renamed history in=channel:#iirc in=existing-direct:op",
          "<< @batch=h :op!u@h TOPIC #iirc :old topic",
          "?? activity TopicChanged #iirc by=op setBy=op setAt=t+0s history in=channel:#iirc :old topic",
          "<< @batch=h :op!u@h MODE #iirc +m-t",
          "?? activity ModeChanged #iirc by=op +m -t history in=channel:#iirc",
          "<< @batch=h :op!u@h MODE #iirc -o op",
          "?? activity ModeChanged #iirc by=op -o=op history in=channel:#iirc",
          "<< @batch=h :peer!u@h AWAY :out",
          "?? activity AwayChanged peer history in=existing-direct:peer :out",
          "<< @batch=h :iirc!u@elsewhere KICK #iirc iirc :old kick",
          "?? activity Kicked #iirc iirc by=iirc history in=channel:#iirc :old kick",
          "<< @batch=h :irc.test 353 iirc = #iirc :nobody",
          "<< @batch=h :irc.test 366 iirc #iirc :End",
          "<< @batch=h :irc.test 332 iirc #iirc :replied in history",
          "<< @batch=h :irc.test 001 iirc :again",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    const never = play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("batch"),
        lines("<< :irc.test 332 iirc #iirc :the topic", "<< :irc.test 324 iirc #iirc +nt"),
      ],
    });

    expect(withHistory.known(now.state)).toStrictEqual(withHistory.known(never.state));
    expect(withHistory.inspect(now.state).states).toStrictEqual(
      withHistory.inspect(never.state).states
    );
  });

  it("can be told from live News with the same id", () => {
    play(withHistory, {
      configuration: base,
      transcript: [
        ...inChannel("message-tags", "batch"),
        lines(
          "<< @msgid=m1 :peer!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg peer #iirc id=ircd:m1 in=channel:#iirc :hi",
          "<< :irc.test BATCH +h chathistory #iirc",
          "<< @batch=h;msgid=m1 :peer!u@h PRIVMSG #iirc :hi",
          "?? message Privmsg peer #iirc id=ircd:m1 history in=channel:#iirc :hi",
          "<< :irc.test BATCH -h"
        ),
      ],
    });

    expect.assertions(0);
  });
});
