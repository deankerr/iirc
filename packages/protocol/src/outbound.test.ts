import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  authenticate,
  away,
  cap,
  encode,
  isRejected,
  join,
  maxLineBytes,
  maxTagBytes,
  mode,
  names,
  nick,
  notice,
  outbound,
  parse,
  part,
  ping,
  pong,
  privmsg,
  quit,
  tagmsg,
  user,
  who,
  withTags,
} from "./line.ts";
import type { OutboundLine, Rejected } from "./line.ts";

const text = new TextDecoder();

const sendableLine = (built: OutboundLine | Rejected): OutboundLine => {
  if (isRejected(built)) {
    throw new Error(`Expected a Line, not ${built.reason}`);
  }

  return built;
};

const wire = (built: OutboundLine | Rejected) => text.decode(encode(sendableLine(built)));

describe(encode, () => {
  it("writes the last parameter as trailing only when it must be", () => {
    expect(wire(outbound("PRIVMSG", ["#a", "hi"]))).toBe("PRIVMSG #a hi\r\n");
    expect(wire(outbound("PRIVMSG", ["#a", "hi there"]))).toBe("PRIVMSG #a :hi there\r\n");
    expect(wire(outbound("PRIVMSG", ["#a", ":)"]))).toBe("PRIVMSG #a ::)\r\n");
    expect(wire(outbound("PRIVMSG", ["#a", ""]))).toBe("PRIVMSG #a :\r\n");
    expect(wire(outbound("QUIT", []))).toBe("QUIT\r\n");
  });

  it("escapes tag values, and writes an empty one as its key alone", () => {
    expect(wire(outbound("TAGMSG", ["#a"], { "+draft/react": "a; b\\c\r\n", "+typing": "" }))).toBe(
      "@+draft/react=a\\:\\sb\\\\c\\r\\n;+typing TAGMSG #a\r\n"
    );
  });

  it("upper-cases the command", () => {
    expect(wire(outbound("privmsg", ["#a", "hi"]))).toBe("PRIVMSG #a hi\r\n");
  });
});

describe(outbound, () => {
  it.each([
    [
      "a second Line in the last parameter",
      "PRIVMSG",
      ["#a", "hi\r\nQUIT :pwned"],
      "InvalidParameter",
    ],
    ["a bare LF", "PRIVMSG", ["#a", "hi\nQUIT"], "InvalidParameter"],
    ["NUL", "PRIVMSG", ["#a", "hi\0"], "InvalidParameter"],
    ["a lone surrogate", "PRIVMSG", ["#a", "\uD800"], "InvalidParameter"],
    ["a space in a middle parameter", "PRIVMSG", ["#a b", "hi"], "InvalidParameter"],
    ["a colon starting a middle parameter", "PRIVMSG", [":a", "hi"], "InvalidParameter"],
    ["an empty middle parameter", "PRIVMSG", ["", "hi"], "InvalidParameter"],
    ["a command that is not one", "PRIV MSG", [], "InvalidCommand"],
    ["a command of four digits", "0001", [], "InvalidCommand"],
    ["sixteen parameters", "X", Array.from({ length: 16 }, () => "x"), "TooManyParameters"],
    ["511 bytes", "PRIVMSG", ["#a", "x".repeat(maxLineBytes - 11)], "TooLong"],
  ] as const)("refuses %s", (_name, command, params, reason) => {
    expect(outbound(command, params)).toStrictEqual({ _tag: "Rejected", reason });
  });

  it("takes a Line of exactly 510 bytes, counting the colon it may need", () => {
    const line = outbound("PRIVMSG", ["#a", "x".repeat(maxLineBytes - 12)]);

    expect(encode(sendableLine(line))).toHaveLength(maxLineBytes + 1);
  });

  it("counts bytes, not characters", () => {
    expect(outbound("PRIVMSG", ["#a", "é".repeat(250)])).toStrictEqual({
      _tag: "Rejected",
      reason: "TooLong",
    });
  });

  it.each([
    [{ time: "2026-11-08T00:00:00Z" }, "InvalidTag"],
    [{ "+a": "\0" }, "InvalidTag"],
    [{ "+bad key": "x" }, "InvalidTag"],
    [{ "+big": ";".repeat(2100) }, "TagsTooLong"],
  ] as const)("refuses the tags %j", (tags, reason) => {
    expect(outbound("TAGMSG", ["#a"], tags)).toStrictEqual({ _tag: "Rejected", reason });
  });
});

describe(withTags, () => {
  it("adds a label to a Line, and replaces one there", () => {
    const line = withTags(sendableLine(privmsg("#a", "hi")), { label: "l1" });

    expect(wire(line)).toBe("@label=l1 PRIVMSG #a hi\r\n");
    expect(wire(withTags(sendableLine(line), { label: "l2" }))).toBe("@label=l2 PRIVMSG #a hi\r\n");
  });

  it("refuses a tag the Ircd would take for its own", () => {
    expect(withTags(sendableLine(privmsg("#a", "hi")), { account: "x" })).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidTag",
    });
  });
});

describe("the builders", () => {
  it.each([
    [privmsg("#iirc", "hello world"), "PRIVMSG #iirc :hello world"],
    [notice("alice", "hi"), "NOTICE alice hi"],
    [tagmsg("#iirc", { "+typing": "active" }), "@+typing=active TAGMSG #iirc"],
    [join(["#a", "&b"]), "JOIN #a,&b"],
    [part("#a"), "PART #a"],
    [part("#a", "see you"), "PART #a :see you"],
    [quit(), "QUIT"],
    [quit("bye"), "QUIT bye"],
    [nick("iirc_"), "NICK iirc_"],
    [user("iirc", "iirc transcript spike"), "USER iirc 0 * :iirc transcript spike"],
    [cap("LS", "302"), "CAP LS 302"],
    [cap("REQ", "sasl multi-prefix"), "CAP REQ :sasl multi-prefix"],
    [cap("END"), "CAP END"],
    [authenticate("PLAIN"), "AUTHENTICATE PLAIN"],
    [authenticate("*"), "AUTHENTICATE *"],
    [ping("iirc-1"), "PING iirc-1"],
    [pong("irc.example.com"), "PONG irc.example.com"],
    [pong(""), "PONG :"],
    [names("#iirc"), "NAMES #iirc"],
    [mode("#iirc"), "MODE #iirc"],
    [mode("#iirc", ["+o", "alice"]), "MODE #iirc +o alice"],
    [who("#iirc", "%tcnuhra,1"), "WHO #iirc %tcnuhra,1"],
    [away("lunch"), "AWAY lunch"],
    [away(), "AWAY"],
  ] as const)("build %#", (built, expected) => {
    expect(wire(built)).toBe(`${expected}\r\n`);
  });

  it.each([
    ["a list of Targets", privmsg("#a,#b", "hi"), "InvalidTarget"],
    ["a Target with a space", privmsg("#a b", "hi"), "InvalidTarget"],
    ["a Target with a line break", notice("a\r\nQUIT", "hi"), "InvalidTarget"],
    ["an empty Message", privmsg("#a", ""), "EmptyText"],
    ["a Message with a line break", privmsg("#a", "hi\r\nQUIT"), "InvalidParameter"],
    ["JOIN 0, which leaves every Channel", join(["0"]), "InvalidTarget"],
    ["JOIN of nothing", join([]), "InvalidTarget"],
    ["JOIN of a list in one name", join(["#a,#b"]), "InvalidTarget"],
    ["PART of two Channels", part("#a,#b"), "InvalidTarget"],
    ["a nick that is a mask", nick("a*"), "InvalidTarget"],
    ["a nick with a source in it", nick("a!b@c"), "InvalidTarget"],
    ["a mechanism with a space", authenticate("PLAIN X"), "InvalidTarget"],
    ["a MODE of two Targets", mode("#a,#b"), "InvalidTarget"],
  ] as const)("refuses %s", (_name, built, reason) => {
    expect(built).toStrictEqual({ _tag: "Rejected", reason });
  });
});

// Middle parameters from the characters that matter, and any text at all for the last.
const middle = fc.stringMatching(/^[^\s:\0\r\n][^\s\0\r\n]{0,20}$/u);
const anyText = fc.string({ maxLength: 120, unit: "binary" });

const lastParam = fc.oneof(
  anyText,
  fc.constantFrom("", ":", " ", "::x", " lead", "trail ", "a\r\nQUIT", "\0")
);

const params = fc
  .tuple(fc.array(middle, { maxLength: 16 }), fc.option(lastParam))
  .map(([middles, last]) => (last === null ? middles : [...middles, last]));

const command = fc.oneof(
  fc.stringMatching(/^[A-Za-z]{1,12}$/u),
  fc.stringMatching(/^\d{3}$/u),
  fc.constantFrom("", "A B", "12", "1234", "É")
);

const tagKey = fc.oneof(
  fc.stringMatching(/^\+(?:[a-z.]{1,8}\/)?[A-Za-z0-9-]{1,10}$/u),
  fc.constantFrom("label", "batch", "draft/multiline-concat", "time", "+", "+a b")
);

const tags = fc.dictionary(tagKey, anyText, { maxKeys: 4 });

const sendable = fc
  .tuple(command, params, tags)
  .map(([verb, values, tagged]) => outbound(verb, values, tagged))
  .filter((built): built is OutboundLine => !isRejected(built));

const bytesOf = (line: OutboundLine) => encode(line);

describe("every OutboundLine", () => {
  it("is built often enough from these generators to prove something", () => {
    const built = fc.sample(
      fc
        .tuple(command, params, tags)
        .map(([verb, values, tagged]) => outbound(verb, values, tagged)),
      2000
    );

    expect(built.filter((line) => !isRejected(line)).length).toBeGreaterThan(200);
  });

  it("parses back to its command, parameters, and tags", () => {
    expect(() => {
      fc.assert(
        fc.property(sendable, (line) => {
          const encoded = bytesOf(line).subarray(0, -2);
          const parsed = parse(encoded, { _tag: "Utf8Only" });
          const sent = line;

          expect(parsed).toStrictEqual({
            _tag: "Line",
            line: {
              command: sent.command,
              params: sent.params,
              source: undefined,
              tags: new Map(Object.entries(sent.tags)),
            },
          });
        }),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });

  it("holds no NUL, CR, or LF but its line ending, and fits", () => {
    expect(() => {
      fc.assert(
        fc.property(sendable, (line) => {
          const encoded = bytesOf(line);
          const body = encoded.subarray(0, -2);
          const space = body.indexOf(0x20);
          const tagged = body[0] === 0x40;
          const tagLength = tagged ? space + 1 : 0;

          expect(text.decode(encoded.subarray(-2))).toBe("\r\n");
          expect(body.some((byte) => byte === 0 || byte === 0x0d || byte === 0x0a)).toBeFalsy();
          expect(encoded.length - tagLength).toBeLessThanOrEqual(maxLineBytes + 2);
          expect(tagLength).toBeLessThanOrEqual(maxTagBytes);
        }),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });

  it("is never a second Line, whatever the text it was asked to carry", () => {
    expect(() => {
      fc.assert(
        fc.property(middle, anyText, (target, said) => {
          const built = privmsg(target, said);

          return isRejected(built) || text.decode(encode(built)).split("\r\n").length === 2;
        }),
        { numRuns: 3000 }
      );
    }).not.toThrow();
  });
});
