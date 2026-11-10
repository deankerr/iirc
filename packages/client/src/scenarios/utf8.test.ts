/**
 * `UTF8ONLY`: while the Ircd says it, bytes are read as UTF-8 with no fallback, and
 * nothing leaves that is not UTF-8.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { FeatureName } from "../ids.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const utf8Only = [...floorIsupport, "UTF8ONLY"];

describe("UTF8ONLY", () => {
  it("reads bytes as UTF-8 with no fallback", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: utf8Only }),
        lines(
          "<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9",
          "?? message Privmsg peer iirc in=direct:peer :caf�"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("reads with the fallback without it, when it is taken back, or when declined", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9",
          "?? message Privmsg peer iirc in=direct:peer :café"
        ),
      ],
    });
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: utf8Only }),
        lines(
          "<< :irc.test 005 iirc -UTF8ONLY :are supported by this server",
          "<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9",
          "?? message Privmsg peer iirc in=direct:peer :café"
        ),
      ],
    });

    const declined = configured({ declined: [FeatureName.make("utf8only")] });

    play(client, {
      configuration: declined,
      transcript: [
        registered(declined, { isupport: utf8Only }),
        lines(
          "<<\\ :peer!u@h PRIVMSG iirc :caf\\xe9",
          "?? message Privmsg peer iirc in=direct:peer :café"
        ),
      ],
    });

    expect.assertions(0);
  });

  it("refuses to answer a PING token that is not UTF-8, and sends nothing", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: utf8Only }),
        lines("<<\\ PING :t\\xe9", "?? ignored Unsendable PONG"),
      ],
    });
    play(client, {
      configuration: base,
      transcript: [registered(base), lines("<<\\ PING :t\\xe9", ">>\\ PONG t\\xe9")],
    });

    expect.assertions(0);
  });

  it("answers a PING token that is UTF-8 byte for byte", () => {
    play(client, {
      configuration: base,
      transcript: [registered(base, { isupport: utf8Only }), lines("<< PING :tó", ">> PONG tó")],
    });

    expect.assertions(0);
  });

  it("refuses a Say that cannot be UTF-8", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base, { isupport: utf8Only }),
        joined(base, "#iirc"),
        lines("!! say #iirc :bad \uD800 half", "?? refused i1 Unsendable"),
      ],
    });

    expect.assertions(0);
  });
});
