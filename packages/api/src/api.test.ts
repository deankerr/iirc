import { Instant } from "@iirc/client";
import { TimelineId, cursorOf, timelineIdOf } from "@iirc/timelines";
import { Option, Redacted, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { DaemonApi, requestParseOptions } from "./api.ts";
import {
  CallerIntent,
  Cursor,
  ItemAfter,
  NetworkId,
  NewsEvent,
  Resume,
  SayRequest,
  SignInRequest,
  TimelineChangesEvent,
  WindowQuery,
} from "./schemas.ts";

const document = OpenApi.fromApi(DaemonApi);

describe("the contract", () => {
  it("puts every route under /api, and every one but signing in and out behind a key or a sign-in", () => {
    const routes = Object.entries(document.paths).flatMap(([path, operations]) =>
      (["get", "put", "post", "delete"] as const).flatMap((method) => {
        const operation = operations[method];

        return operation === undefined
          ? []
          : [{ route: `${method.toUpperCase()} ${path}`, security: operation.security }];
      })
    );

    const guarded = routes.filter(({ route }) => !route.endsWith(" /api/sign-in"));

    expect(routes.map(({ route }) => route).toSorted()).toStrictEqual([
      "DELETE /api/credentials/{name}",
      "DELETE /api/sign-in",
      "GET /api/credentials",
      "GET /api/networks",
      "GET /api/networks/{network}/at/{sequence}",
      "GET /api/networks/{network}/inspect",
      "GET /api/networks/{network}/known",
      "GET /api/networks/{network}/said/{intent}",
      "GET /api/networks/{network}/timelines",
      "GET /api/news",
      "GET /api/timelines/changes",
      "GET /api/timelines/{timeline}",
      "POST /api/networks/{network}/retry",
      "POST /api/networks/{network}/say",
      "POST /api/sign-in",
      "PUT /api/credentials/{name}",
      "PUT /api/networks/{network}",
    ]);
    expect(new Set(guarded.map(({ security }) => JSON.stringify(security)))).toStrictEqual(
      new Set(['[{"bearer":[]},{"signIn":[]}]'])
    );
    expect(
      routes.filter(({ route }) => route.endsWith(" /api/sign-in")).map(({ security }) => security)
    ).toStrictEqual([[], []]);
    expect(document.components.securitySchemes).toStrictEqual({
      bearer: { scheme: "Bearer", type: "http" },
      signIn: { in: "cookie", name: "iirc_sign_in", type: "apiKey" },
    });
  });

  it("takes a key to sign in with, and nothing else", () => {
    const signIn = Schema.decodeUnknownOption(SignInRequest, requestParseOptions);
    const decoded = signIn({ key: "iirc_abc" });

    expect([
      decoded.pipe(Option.map(({ key }) => Redacted.value(key))),
      JSON.stringify(decoded).includes("iirc_abc"),
      signIn({ key: "" }),
      signIn({ key: "iirc_abc", remember: true }),
    ]).toStrictEqual([Option.some("iirc_abc"), false, Option.none(), Option.none()]);
  });

  it("parses ids that are safe in a path, and refuses the rest", () => {
    const network = Schema.is(NetworkId);
    const intent = Schema.is(CallerIntent);

    expect([network("libera"), network("Libera"), network("../x"), network("")]).toStrictEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([
      intent("a1.b_c~d-e"),
      intent("..."),
      intent("a/b"),
      intent("a".repeat(129)),
      intent("."),
      intent(".."),
    ]).toStrictEqual([true, true, false, false, false, false]);
  });

  it("refuses to say text no Line can carry", () => {
    const say = Schema.is(SayRequest);

    expect([
      say({ kind: "Privmsg", target: "#iirc", text: "fine" }),
      say({ kind: "Privmsg", target: "#iirc", text: "two\r\nlines" }),
      say({ kind: "Privmsg", target: "", text: "no target" }),
    ]).toStrictEqual([true, false, false]);
  });

  it("carries a step's sequence as its event id, and a heartbeat with none", () => {
    const wire = [
      { data: '{"at":1,"network":"libera","news":[],"sequence":7}', event: "happened", id: "7" },
      { data: "{}", event: "heartbeat" },
    ];

    const decoded = wire.map((event) => Schema.decodeUnknownSync(NewsEvent)(event));

    expect(
      decoded.map((event) => (event.event === "happened" ? event.id : undefined))
    ).toStrictEqual([7, undefined]);
    expect(decoded.map((event) => Schema.encodeSync(NewsEvent)(event))).toStrictEqual(wire);
  });

  it("parses a cursor into its position, and refuses text that is not one", () => {
    const position = { at: Instant.make(1_762_560_000_000), n: 2, sequence: 7 };
    const cursor = cursorOf(position);
    const decode = Schema.decodeUnknownOption(Cursor);

    expect([
      decode(cursor),
      decode(cursor.toUpperCase()),
      decode(`${cursor}0`),
      decode(cursorOf({ ...position, sequence: 0 })),
      Schema.encodeSync(Cursor)(position),
    ]).toStrictEqual([Option.some(position), Option.none(), Option.none(), Option.none(), cursor]);
  });

  it("takes at most one place to read a window from, and a limit within bounds", () => {
    const cursor = cursorOf({ at: Instant.make(0), n: 0, sequence: 1 });
    const query = Schema.decodeUnknownOption(WindowQuery);

    expect(
      [
        {},
        { before: cursor, limit: "50" },
        { around: cursor },
        { after: cursor, before: cursor },
        { limit: "0" },
        { limit: "501" },
        { limit: "1.5" },
        { after: "nope" },
      ].map((each) => Option.isSome(query(each)))
    ).toStrictEqual([true, true, true, false, false, false, false, false]);
  });

  it("takes a Timeline's id as the fold gives it, and nothing else", () => {
    const id = Schema.is(TimelineId);

    expect([id(timelineIdOf(42, 3, 1)), id("../x"), id("changes"), id("")]).toStrictEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("carries where a folded step leaves a follower as its event id, and a reset or heartbeat with none", () => {
    const data = { gaps: [], items: [], merged: [], sequence: 9, timelines: [] };

    const wire = [
      { data: JSON.stringify(data), event: "changed", id: "1.9" },
      { data: JSON.stringify({ sequence: 10, timelines: null }), event: "overflowed", id: "1.10" },
      { data: JSON.stringify({ through: 10, version: 2 }), event: "reset" },
      { data: "{}", event: "heartbeat" },
    ];

    const decoded = wire.map((event) => Schema.decodeUnknownSync(TimelineChangesEvent)(event));

    expect(decoded.map((event) => ("id" in event ? event.id : undefined))).toStrictEqual([
      { sequence: 9, version: 1 },
      { sequence: 10, version: 1 },
      undefined,
      undefined,
    ]);
    expect(decoded.map((event) => Schema.encodeSync(TimelineChangesEvent)(event))).toStrictEqual(
      wire
    );
  });

  it("parses where to resume the changes, and refuses anything else", () => {
    const resume = Schema.decodeUnknownOption(Resume);

    expect(
      [
        "1.0",
        "1.100",
        "0.0",
        "1",
        "1.",
        ".1",
        "01.1",
        "1.01",
        "-1.1",
        "1.1.1",
        "1.99999999999999999",
      ].map((each) => resume(each))
    ).toStrictEqual([
      Option.some({ sequence: 0, version: 1 }),
      Option.some({ sequence: 100, version: 1 }),
      Option.some({ sequence: 0, version: 0 }),
      ...Array.from({ length: 8 }, () => Option.none()),
    ]);
    expect(Schema.encodeSync(Resume)({ sequence: 100, version: 1 })).toBe("1.100");
  });

  it("marks every message id a Network gave as Untrusted", () => {
    // A fact's value or what it was, when it is a string with no name of its own, is text
    // the document does not mark. Every message id is the named, Untrusted one instead.
    const text = JSON.stringify(document);
    const marked = '{"$ref":"#/components/schemas/UntrustedMessageId"}';

    expect([
      text.includes('"value":{"type":"string"}'),
      text.includes('"was":{"type":"string"}'),
      text.split(`"value":${marked}`).length - 1 >= 5,
      text.split(`"was":${marked}`).length - 1 >= 5,
      text.includes('"UntrustedMessageId":{"type":"string","description":"Untrusted: '),
    ]).toStrictEqual([false, false, true, true, true]);
  });

  it("parses where the next page of a step's items begins, and refuses anything else", () => {
    const position = { at: Instant.make(1_762_560_000_000), n: 1, sequence: 7 };
    const timeline = timelineIdOf(3, 0, 1);
    const text = `${cursorOf(position)}.${timeline}`;
    const after = Schema.decodeUnknownOption(ItemAfter);

    expect([
      after(text),
      after(cursorOf(position)),
      after(`${cursorOf(position)}.nope`),
      after(`${text}.${timeline}`),
      Schema.encodeSync(ItemAfter)({ position, timeline }),
    ]).toStrictEqual([
      Option.some({ position, timeline }),
      Option.none(),
      Option.none(),
      Option.none(),
      text,
    ]);
  });
});
