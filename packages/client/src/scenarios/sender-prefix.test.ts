/**
 * A Message in a Channel carries the prefix its sender held there as the Line was folded:
 * the symbol of the highest of their modes by `PREFIX`, or none. It is fixed when said.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, play, registered, joined } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const isupport = ["CASEMAPPING=rfc1459", "CHANTYPES=#", "PREFIX=(qaohv)~&@%+"];

const inChannel = (names: readonly string[], offered: readonly string[] = ["multi-prefix"]) => [
  registered(base, { isupport, offered }),
  joined(base, "#iirc", names),
];

const run = (transcript: readonly string[]) => {
  play(client, { configuration: base, transcript });
};

describe("a Message's sender prefix", () => {
  it("is the highest of several the sender holds, by PREFIX", () => {
    run([
      ...inChannel(["+@both", "~&@%+owner"]),
      lines(
        "<< :both!u@h PRIVMSG #iirc :hi",
        '?? message Privmsg both #iirc prefix="@" in=channel:#iirc :hi',
        "<< :owner!u@h PRIVMSG #iirc :hi",
        "?? message Privmsg owner #iirc prefix=~ in=channel:#iirc :hi"
      ),
    ]);

    expect.assertions(0);
  });

  it("is the one the sender holds, as a NOTICE and an action too", () => {
    run([
      ...inChannel(["+voiced"]),
      lines(
        "<< :voiced!u@h NOTICE #iirc :hi",
        "?? message Notice voiced #iirc prefix=+ in=channel:#iirc :hi",
        "<<\\ :voiced!u@h PRIVMSG #iirc :\\x01ACTION waves\\x01",
        "?? message Action voiced #iirc prefix=+ in=channel:#iirc :waves"
      ),
    ]);

    expect.assertions(0);
  });

  it("is the highest one known without multi-prefix, where a listing shows only it", () => {
    run([
      ...inChannel(["@+op"], []),
      lines(
        "<< :op!u@h PRIVMSG #iirc :hi",
        '?? message Privmsg op #iirc prefix="@" in=channel:#iirc :hi'
      ),
    ]);

    expect.assertions(0);
  });

  it("is none for a sender who holds none", () => {
    run([
      ...inChannel(["peer"]),
      lines("<< :peer!u@h PRIVMSG #iirc :hi", "?? message Privmsg peer #iirc in=channel:#iirc :hi"),
    ]);

    expect.assertions(0);
  });

  it("is none for a sender who is no member", () => {
    run([
      ...inChannel(["@op"]),
      lines(
        "<< :stranger!u@h PRIVMSG #iirc :hi",
        "?? message Privmsg stranger #iirc in=channel:#iirc :hi"
      ),
    ]);

    expect.assertions(0);
  });

  it("is none in a Direct Message, even from one who holds a prefix in a Channel", () => {
    run([
      ...inChannel(["@op"]),
      lines("<< :op!u@h PRIVMSG iirc :psst", "?? message Privmsg op iirc in=direct:op :psst"),
    ]);

    expect.assertions(0);
  });

  it("is none in a Channel Self is not in", () => {
    run([
      ...inChannel(["@op"]),
      lines(
        "<< :op!u@h PRIVMSG #elsewhere :hi",
        "?? message Privmsg op #elsewhere in=channel:#elsewhere :hi"
      ),
    ]);

    expect.assertions(0);
  });

  it("finds a sender by the Network's casemapping", () => {
    run([
      ...inChannel(["@op"]),
      lines(
        "<< :OP!u@h PRIVMSG #iirc :hi",
        '?? message Privmsg OP #iirc prefix="@" in=channel:#iirc :hi'
      ),
    ]);

    expect.assertions(0);
  });

  it("is Self's own for a Message Self says, where Self is an operator", () => {
    run([
      ...inChannel(["@iirc"]),
      lines(
        "!! say #iirc :hi",
        '?? message Privmsg iirc #iirc at=ours:t+0s prefix="@" in=channel:#iirc ours=i1 :hi',
        ">> PRIVMSG #iirc hi"
      ),
    ]);

    expect.assertions(0);
  });

  it("is fixed when said, whatever the sender holds after", () => {
    run([
      ...inChannel(["@op"]),
      lines(
        "<< :op!u@h PRIVMSG #iirc :first",
        '?? message Privmsg op #iirc prefix="@" in=channel:#iirc :first',
        "<< :irc.test MODE #iirc -o op",
        "<< :op!u@h PRIVMSG #iirc :second",
        "?? message Privmsg op #iirc in=channel:#iirc :second",
        "<< :irc.test MODE #iirc +v op",
        "<< :op!u@h PRIVMSG #iirc :third",
        "?? message Privmsg op #iirc prefix=+ in=channel:#iirc :third"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a Message said while a NAMES listing is still arriving", () => {
  it("carries the prefix the listing has already shown", () => {
    run([
      registered(base, { isupport, offered: ["multi-prefix"] }),
      lines(
        "!! configure +#iirc",
        ">> JOIN #iirc",
        "<< :iirc!~iirc@iirc.test JOIN #iirc",
        ">> MODE #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc @peer",
        "<< :peer!u@h PRIVMSG #iirc :hi",
        '?? message Privmsg peer #iirc prefix="@" in=channel:#iirc :hi',
        "<< :irc.test 366 iirc #iirc :End of /NAMES list."
      ),
    ]);

    expect.assertions(0);
  });
});
