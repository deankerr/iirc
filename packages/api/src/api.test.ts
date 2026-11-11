import { Instant } from "@iirc/client";
import { TimelineId, cursorOf, timelineIdOf } from "@iirc/timelines";
import { Option, Redacted, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { DaemonApi, requestParseOptions } from "./api.ts";
import {
  ActRequest,
  CallerIntent,
  Cursor,
  IfSequence,
  ItemAfter,
  MemberPage,
  MembersAfter,
  MembersQuery,
  NetworkId,
  NewsEvent,
  Resume,
  ReadRequest,
  SayRequest,
  SignInRequest,
  TimelineChangesEvent,
  UiEvent,
  UiValue,
  WindowQuery,
} from "./schemas.ts";
import { UiInForce, UiOptionName, UiOptions, uiDefaults, uiOptionNames } from "./ui.ts";

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
      "DELETE /api/ui/{option}",
      "GET /api/credentials",
      "GET /api/networks",
      "GET /api/networks/{network}/at/{sequence}",
      "GET /api/networks/{network}/configuration",
      "GET /api/networks/{network}/inspect",
      "GET /api/networks/{network}/known",
      "GET /api/networks/{network}/said/{intent}",
      "GET /api/networks/{network}/timelines",
      "GET /api/news",
      "GET /api/timelines/changes",
      "GET /api/timelines/{timeline}",
      "GET /api/timelines/{timeline}/channel",
      "GET /api/timelines/{timeline}/members",
      "GET /api/ui",
      "GET /api/ui/changes",
      "POST /api/networks/{network}/act",
      "POST /api/networks/{network}/read",
      "POST /api/networks/{network}/retry",
      "POST /api/networks/{network}/say",
      "POST /api/sign-in",
      "PUT /api/credentials/{name}",
      "PUT /api/networks/{network}",
      "PUT /api/ui/{option}",
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

  it("takes an action whole, and refuses one no Line could carry, or with a field nothing reads", () => {
    const act = Schema.decodeUnknownResult(ActRequest);
    const strict = Schema.decodeUnknownResult(ActRequest, requestParseOptions);

    expect(
      [
        { action: { _tag: "Topic", channel: "#iirc", text: "" } },
        { action: { _tag: "Kick", channel: "#iirc", nicks: ["a", "b"], reason: null } },
        {
          action: {
            _tag: "Mode",
            changes: [{ mode: "o", param: "peer", set: true }],
            target: "#iirc",
          },
          intent: "mine",
        },
        { action: { _tag: "Invite", channel: "#iirc", nick: "peer" } },
        { action: { _tag: "Nick", nick: "other" } },
        { action: { _tag: "Away", message: null } },
        { action: { _tag: "Raw", line: "WHOIS peer" } },
      ].map((each) => act(each)._tag)
    ).toStrictEqual(Array.from({ length: 7 }, () => "Success"));
    expect(
      [
        { action: { _tag: "Topic", channel: "#iirc", text: "two\r\nlines" } },
        { action: { _tag: "Kick", channel: "#iirc", nicks: [], reason: null } },
        { action: { _tag: "Mode", changes: [], target: "#iirc" } },
        { action: { _tag: "Nick", nick: "" } },
        { action: { _tag: "Raw", line: "PING a\0" } },
        { action: { _tag: "Away", message: "a\nb" } },
        { action: { _tag: "Quit" } },
      ].map((each) => act(each)._tag)
    ).toStrictEqual(Array.from({ length: 7 }, () => "Failure"));
    expect(strict({ action: { _tag: "Nick", extra: 1, nick: "a" } })._tag).toBe("Failure");
  });

  it("takes a read up to an instant, of a Target or, with null, the Network's own", () => {
    const read = Schema.decodeUnknownResult(ReadRequest);

    expect(
      [
        { read: 1_762_560_000_000, target: "#iirc" },
        { read: 1_762_560_000_000, target: null },
        { read: 1_762_560_000_000 },
        { read: 1.5, target: "#iirc" },
        { read: 1, target: "" },
        { read: 1, target: "#a\r\nb" },
      ].map((payload) => read(payload)._tag)
    ).toStrictEqual(["Success", "Success", "Failure", "Failure", "Failure", "Failure"]);
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

  it("takes the Configuration a PUT was made from as a sequence, or 0 for none, and says 409 when it changed", () => {
    const parse = Schema.decodeUnknownOption(IfSequence);
    const put = document.paths["/api/networks/{network}"]?.put;

    expect({
      parsed: ["0", "12", "-1", "1.5", "x", ""].map((each) => Option.getOrNull(parse(each))),
      statuses: Object.keys(put?.responses ?? {}).toSorted(),
    }).toStrictEqual({
      parsed: [0, 12, null, null, null, null],
      statuses: ["200", "400", "401", "403", "409", "503"],
    });
  });

  it("says what each ui option is and starts as, and takes only an option it has", () => {
    const option = Schema.decodeUnknownOption(UiOptionName);
    const options = Schema.decodeUnknownOption(UiOptions);
    const set = document.paths["/api/ui/{option}"]?.put;

    expect({
      defaults: uiDefaults,
      names: uiOptionNames,
      option: ["time", "theme", "activity", "nope", "TIME", ""].map((each) =>
        Option.getOrNull(option(each))
      ),
      options: [
        { activity: "quiet", theme: "dark", time: "HH:mm:ss" },
        { activity: "loud", theme: "dark", time: "HH:mm" },
        { theme: "dark", time: "HH:mm" },
      ].map((each) => Option.isSome(options(each))),
      statuses: Object.keys(set?.responses ?? {}).toSorted(),
      value: [{ value: "dark" }, { value: { any: ["json", 1] } }, {}, { other: 2, value: 1 }].map(
        (each) => Option.isSome(Schema.decodeUnknownOption(UiValue, requestParseOptions)(each))
      ),
    }).toStrictEqual({
      defaults: { activity: "all", theme: "system", time: "HH:mm" },
      names: ["activity", "theme", "time"],
      option: ["time", "theme", "activity", null, null, null],
      options: [true, false, false],
      statuses: ["200", "400", "401", "403", "409", "500"],
      value: [true, true, false, false],
    });
  });

  it("carries the ui options whole with the last Change's sequence as the event id, from 0 for none", () => {
    const wire = [
      {
        data: '{"options":{"activity":"all","theme":"system","time":"HH:mm"},"sequence":0}',
        event: "changed",
        id: "0",
      },
      {
        data: '{"options":{"activity":"quiet","theme":"dark","time":"HH:mm:ss"},"sequence":9}',
        event: "changed",
        id: "9",
      },
      { data: "{}", event: "heartbeat" },
    ];

    const decoded = wire.map((event) => Schema.decodeUnknownSync(UiEvent)(event));

    expect({
      encoded: decoded.map((event) => Schema.encodeSync(UiEvent)(event)),
      ids: decoded.map((event) => (event.event === "changed" ? event.id : undefined)),
      negative: Option.isSome(
        Schema.decodeOption(UiInForce)({ options: uiDefaults, sequence: -1 })
      ),
    }).toStrictEqual({ encoded: wire, ids: [0, 9, undefined], negative: false });
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

  it("parses where the next page of members begins, and refuses anything the Daemon could not give", () => {
    const after = Schema.decodeUnknownOption(MembersAfter);
    const place = { key: "{a}|b^", rank: 2 };
    const text = Schema.encodeSync(MembersAfter)(place);
    const wide = { key: "nick\u{1F600}é", rank: 0 };

    expect([
      text,
      after(text),
      after(Schema.encodeSync(MembersAfter)(wide)),
      after("2"),
      after("2."),
      after("02.YQ"),
      after("1000.YQ"),
      after("-1.YQ"),
      after("2.YQ=="),
      after("2.Y+"),
      after("2.YR"),
      after("2./w"),
    ]).toStrictEqual([
      "2.e2F9fGJe",
      Option.some(place),
      Option.some(wide),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
      Option.none(),
    ]);
  });

  it("takes a page of members after a place, of up to 500, starting with some text", () => {
    const after = Schema.encodeSync(MembersAfter)({ key: "a", rank: 0 });
    const query = Schema.decodeUnknownOption(MembersQuery);

    expect(
      [
        {},
        { after, limit: "500", prefix: "[a" },
        { prefix: "" },
        { prefix: "x".repeat(511) },
        { limit: "0" },
        { limit: "501" },
        { after: "nope" },
      ].map((each) => Option.isSome(query(each)))
    ).toStrictEqual([true, true, false, false, false, false, false]);
  });

  it("marks every nick, mode, and symbol of a Channel's members as Untrusted, never a key", () => {
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const head = JSON.stringify(document.paths["/api/timelines/{timeline}/channel"]);
    const members = JSON.stringify(document.paths["/api/timelines/{timeline}/members"]);

    const page = Schema.encodeSync(MemberPage)({
      members: [
        {
          away: { _tag: "Unknown" },
          nick: "__proto__",
          prefixes: { _tag: "Partial", at: Instant.make(0), atLeast: ["o"], from: "ircd" },
        },
      ],
      more: false,
      network: NetworkId.make("libera"),
      next: null,
      timeline: timelineIdOf(1, 0, 1),
    });

    expect([
      head.includes(
        `"ranks":{"type":"array","items":{"type":"object","properties":{"mode":${untrusted},"symbol":${untrusted}}`
      ),
      head.includes(`"name":${untrusted}`),
      members.includes(`"nick":${untrusted}`),
      members.includes(`"atLeast":{"type":"array","items":${untrusted}}`),
      page.members.map((one) => [Object.keys(one).toSorted(), one.nick]),
    ]).toStrictEqual([true, true, true, true, [[["away", "nick", "prefixes"], "__proto__"]]]);
  });
});
