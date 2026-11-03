import { describe, expect, it } from "vitest";

import { maxFrameBytes } from "./frame.ts";
import { pingToken } from "./line.ts";
import { encodeLine, maxLineBytes, outbound, part, pong, privmsg, quit, user } from "./outbound.ts";
import type { Outbound } from "./outbound.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wire = (built: Outbound) => {
  if (built._tag === "Rejected") {
    throw new Error(built.reason);
  }

  return encodeLine(built.line);
};

const safe = (built: Outbound) => {
  if (built._tag === "Rejected") {
    throw new Error(built.reason);
  }

  return built.line;
};

describe("an OutboundLine owns its bytes", () => {
  it("keeps what it encodes whatever is done to the bytes it hands out", () => {
    const line = safe(privmsg("#a", "hi"));

    line.toBytes().set(encoder.encode("QUIT"));

    expect(decoder.decode(encodeLine(line))).toBe("PRIVMSG #a hi\r\n");
  });

  it("keeps what it encodes whatever is done to the bytes it encoded before", () => {
    const line = safe(privmsg("#a", "hi"));

    encodeLine(line).fill(0x51);

    expect(decoder.decode(encodeLine(line))).toBe("PRIVMSG #a hi\r\n");
    expect(decoder.decode(line.toBytes())).toBe("PRIVMSG #a hi");
  });

  it("is not changed by the token it was built from", () => {
    const token = encoder.encode("1234");
    const line = safe(pong(token));

    token.fill(0x51);

    expect(decoder.decode(encodeLine(line))).toBe("PONG 1234\r\n");
  });

  it("gives a copy each time, so no two holders share bytes", () => {
    const line = safe(quit("bye"));

    expect(line.toBytes()).not.toBe(line.toBytes());
    expect(line.toBytes()).toStrictEqual(line.toBytes());
  });
});

describe(outbound, () => {
  it("formats a last parameter that needs a colon", () => {
    expect(decoder.decode(wire(outbound("USER", ["claude", "0", "*", "Claude Code"])))).toBe(
      "USER claude 0 * :Claude Code\r\n"
    );
  });

  it.each([
    ["line break in the last parameter", ["#a", "hi\r\nQUIT :pwned"]],
    ["null in the last parameter", ["#a", "hi\0there"]],
    ["line break in a middle parameter", ["#a\r\nQUIT", "k"]],
    ["space in a middle parameter", ["#a b", "k"]],
    ["empty middle parameter", ["", "k"]],
    ["colon in a middle parameter", [":a", "k"]],
  ])("rejects a %s", (_name, params) => {
    expect(outbound("PRIVMSG", params)).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidParameter",
    });
  });

  it.each(["", "PRIV MSG", "PING\r\nQUIT", "12"])("rejects %j as a command", (command) => {
    expect(outbound(command, [])).toStrictEqual({ _tag: "Rejected", reason: "InvalidCommand" });
  });

  it("rejects a Line over the byte limit", () => {
    expect(outbound("PRIVMSG", ["#a", "é".repeat(maxLineBytes / 2)])).toStrictEqual({
      _tag: "Rejected",
      reason: "TooLong",
    });
  });
});

const replyTo = (frame: Uint8Array) => wire(pong(pingToken(frame)));

describe(pong, () => {
  it("LIVE-1: echoes a token that is not UTF-8, byte for byte", () => {
    const frame = Uint8Array.of(...encoder.encode("PING :"), 0xff, 0xfe, 0x80, 0xe9);

    expect(replyTo(frame)).toStrictEqual(
      Uint8Array.of(...encoder.encode("PONG "), 0xff, 0xfe, 0x80, 0xe9, 0x0d, 0x0a)
    );
  });

  it("LIVE-1: keeps every byte a windows-1252 decoder would have changed", () => {
    const token = Uint8Array.from({ length: 0x20 }, (_unused, index) => 0x80 + index);

    expect(pingToken(Uint8Array.of(...encoder.encode("PING "), ...token))).toStrictEqual(token);
  });

  it("LIVE-1: keeps working for an ordinary colon-prefixed trailing token", () => {
    expect(decoder.decode(replyTo(encoder.encode(":irc.test PING :abc123")))).toBe(
      "PONG abc123\r\n"
    );
  });

  it("LIVE-1: echoes valid UTF-8 unchanged", () => {
    expect(decoder.decode(replyTo(encoder.encode("PING ☃")))).toBe("PONG ☃\r\n");
  });

  it("LIVE-1: keeps a token with spaces whole", () => {
    expect(decoder.decode(replyTo(encoder.encode("PING :two words")))).toBe("PONG :two words\r\n");
  });

  it("LIVE-1: keeps a token that starts with a colon", () => {
    expect(decoder.decode(replyTo(encoder.encode("PING ::odd")))).toBe("PONG ::odd\r\n");
  });

  it("LIVE-1: answers an empty trailing token with an empty one", () => {
    expect(decoder.decode(replyTo(encoder.encode("PING :")))).toBe("PONG :\r\n");
  });

  it("LIVE-1: answers a PING with no token with a bare PONG", () => {
    expect(decoder.decode(replyTo(encoder.encode("PING")))).toBe("PONG\r\n");
  });

  it("LIVE-1: echoes only the first parameter", () => {
    expect(decoder.decode(replyTo(encoder.encode("PING first second")))).toBe("PONG first\r\n");
  });

  it("LIVE-1: finds the token past tags and a source, in any case", () => {
    expect(decoder.decode(replyTo(encoder.encode("@a=b :irc.test ping token")))).toBe(
      "PONG token\r\n"
    );
  });

  it.each([0x00, 0x0a, 0x0d])("HOST-1: never lets 0x%x reach the wire from a token", (byte) => {
    expect(pong(Uint8Array.of(0x61, byte, 0x62))).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidParameter",
    });
  });

  it.each([0x00, 0x0d])("HOST-1: a frame holding 0x%x loses the rest, as any Line does", (byte) => {
    const frame = Uint8Array.of(...encoder.encode("PING :abc"), byte, 0x51, 0x55, 0x49, 0x54);

    expect(decoder.decode(replyTo(frame))).toBe("PONG abc\r\n");
  });

  it("reports a token too long to fit a Line", () => {
    const frame = encoder.encode(`PING :${"x".repeat(maxFrameBytes - 6)}`);

    expect(pong(pingToken(frame))).toStrictEqual({ _tag: "Rejected", reason: "TooLong" });
  });

  it("fits a token that lands exactly on the limit, and refuses one byte more", () => {
    const longest = maxLineBytes - "PONG ".length;

    expect(pong(new Uint8Array(longest).fill(0x78))._tag).toBe("Safe");
    expect(pong(new Uint8Array(longest + 1).fill(0x78))._tag).toBe("Rejected");
  });

  it("never throws or breaks framing, whatever the frame", () => {
    const frames = Array.from({ length: 2000 }, (_unused, seed) =>
      Uint8Array.from({ length: seed % 97 }, (_byte, index) => (seed * index * 31) % 256)
    );

    const unsafe = frames
      .map((noise) => pong(pingToken(Uint8Array.of(...encoder.encode("PING "), ...noise))))
      .flatMap((built) => (built._tag === "Safe" ? [encodeLine(built.line).subarray(0, -2)] : []))
      .filter((body) => body.some((byte) => [0x00, 0x0a, 0x0d].includes(byte)));

    expect(unsafe).toStrictEqual([]);
  });
});

describe(privmsg, () => {
  it("builds a Line ending in CRLF", () => {
    expect(decoder.decode(wire(privmsg("#iirc", "hello there")))).toBe(
      "PRIVMSG #iirc :hello there\r\n"
    );
  });

  it.each(["#a,#b", "", "a b"])("rejects %j as a Target", (target) => {
    expect(privmsg(target, "hi")).toStrictEqual({ _tag: "Rejected", reason: "InvalidTarget" });
  });

  it("rejects empty text", () => {
    expect(privmsg("#a", "")).toStrictEqual({ _tag: "Rejected", reason: "EmptyText" });
  });
});

describe(part, () => {
  it("CONF-5: leaves one Channel, with a reason if given", () => {
    expect(decoder.decode(wire(part("#iirc")))).toBe("PART #iirc\r\n");
    expect(decoder.decode(wire(part("#iirc", "off to bed")))).toBe("PART #iirc :off to bed\r\n");
  });

  it.each(["#a,#b", "", "#a b", ":#a", "#a\r\nQUIT"])("rejects %j as a Channel", (channel) => {
    expect(part(channel)).toStrictEqual({ _tag: "Rejected", reason: "InvalidTarget" });
  });

  it("rejects a reason that would break the framing", () => {
    expect(part("#a", "bye\r\nQUIT :pwned")).toStrictEqual({
      _tag: "Rejected",
      reason: "InvalidParameter",
    });
  });
});

describe(quit, () => {
  it("LIVE-9: says why, as the last parameter", () => {
    expect(decoder.decode(wire(quit("back soon")))).toBe("QUIT :back soon\r\n");
  });

  it("LIVE-9: rejects a reason no Line can carry", () => {
    expect(quit("x".repeat(maxLineBytes))).toStrictEqual({ _tag: "Rejected", reason: "TooLong" });
    expect(quit("bye\r\nJOIN 0")._tag).toBe("Rejected");
  });
});

describe(user, () => {
  it("CONN-2: registers in RFC 2812's form, with mode 0", () => {
    expect(decoder.decode(wire(user("cc", "Claude Code")))).toBe("USER cc 0 * :Claude Code\r\n");
  });

  it("CONN-2: rejects a username that is not one word, and a realname too long", () => {
    expect(user("two words", "x")._tag).toBe("Rejected");
    expect(user("", "x")._tag).toBe("Rejected");
    expect(user("cc", "x".repeat(maxLineBytes))).toStrictEqual({
      _tag: "Rejected",
      reason: "TooLong",
    });
  });
});
