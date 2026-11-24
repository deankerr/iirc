import { Instant } from "@iirc/client";
import { TimelineId, cursorOf, timelineIdOf } from "@iirc/timelines";
import { Option, Redacted, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { DaemonApi, requestParseOptions } from "./api.ts";
import {
  ActRequest,
  Activity,
  Attempted,
  CallerIntent,
  Cursor,
  IfSequence,
  ItemAfter,
  LookQuery,
  LookResult,
  LookRequest,
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
  TimelineItem,
  UiEvent,
  UiValue,
  WindowQuery,
} from "./schemas.ts";
import {
  AliasLine,
  AliasName,
  Aliases,
  FontShown,
  MembersWidth,
  NickWidth,
  RowSpacing,
  UiInForce,
  UiOptionName,
  UiOptions,
  isFontName,
  uiDefaults,
  uiOptionNames,
  uiNameKept,
  uiValueKept,
  WidestLine,
  EnterKey,
  NickSuffix,
  nickSuffixMaxLength,
  SpellcheckShown,
  LineLayout,
  ReadRule,
} from "./ui.ts";
import { UploadId, UploadName } from "./uploads.ts";

const document = OpenApi.fromApi(DaemonApi);

/**
 * Aliases of one line, each named for its place.
 * @param count - How many.
 * @returns The aliases.
 */
const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ line: "/join $1", name: `a${index}` }));

/**
 * A font decoded from JSON, or null when refused.
 * @param each - The JSON.
 * @returns The font.
 */
const font = (each: Schema.Json) => Option.getOrNull(Schema.decodeUnknownOption(FontShown)(each));

const roundTrip = (each: Activity) =>
  Schema.decodeSync(Activity)(Schema.encodeSync(Activity)(each));

/**
 * The query parameters an operation of the OpenAPI document declares, with whether each is required.
 * @param path - The path.
 * @param method - The method.
 * @returns Each name, with whether it is required.
 */
const parameters = (path: string, method: "get" | "post") =>
  (document.paths[path]?.[method]?.parameters ?? [])
    .filter((one) => one.in === "query")
    .map((one) => [one.name, one.required]);

// The routes that need no key or sign-in: signing in and out, and whether the Daemon is well.
const open = (route: string) => route.endsWith(" /api/sign-in") || route === "GET /api/health";

describe("the contract", () => {
  it("puts every route under /api, and every one but signing in and out, and health, behind a key or a sign-in", () => {
    const routes = Object.entries(document.paths).flatMap(([path, operations]) =>
      (["get", "put", "post", "patch", "delete"] as const).flatMap((method) => {
        const operation = operations[method];

        return operation === undefined
          ? []
          : [{ route: `${method.toUpperCase()} ${path}`, security: operation.security }];
      })
    );

    const guarded = routes.filter(({ route }) => !open(route));

    expect(routes.map(({ route }) => route).toSorted()).toStrictEqual([
      "DELETE /api/credentials/{name}",
      "DELETE /api/networks/{network}",
      "DELETE /api/options/{option}",
      "DELETE /api/sign-in",
      "DELETE /api/ui/{option}",
      "DELETE /api/uploads/{id}",
      "GET /api/credentials",
      "GET /api/health",
      "GET /api/networks",
      "GET /api/networks/{network}/at/{sequence}",
      "GET /api/networks/{network}/configuration",
      "GET /api/networks/{network}/inspect",
      "GET /api/networks/{network}/known",
      "GET /api/networks/{network}/lookups/{intent}",
      "GET /api/networks/{network}/said/{intent}",
      "GET /api/networks/{network}/timelines",
      "GET /api/news",
      "GET /api/options",
      "GET /api/options/changes",
      "GET /api/previews/changes",
      "GET /api/previews/images/{hash}",
      "GET /api/previews/{id}/stream",
      "GET /api/search",
      "GET /api/tail",
      "GET /api/tail/changes",
      "GET /api/timelines/changes",
      "GET /api/timelines/projection",
      "GET /api/timelines/{timeline}",
      "GET /api/timelines/{timeline}/channel",
      "GET /api/timelines/{timeline}/export",
      "GET /api/timelines/{timeline}/members",
      "GET /api/ui",
      "GET /api/ui/changes",
      "GET /api/uploads",
      "GET /api/uploads/changes",
      "GET /api/uploads/status",
      "GET /api/uploads/{id}",
      "GET /api/uploads/{id}/content",
      "PATCH /api/uploads/{id}",
      "POST /api/networks/{network}/act",
      "POST /api/networks/{network}/close",
      "POST /api/networks/{network}/lookups",
      "POST /api/networks/{network}/read",
      "POST /api/networks/{network}/retry",
      "POST /api/networks/{network}/say",
      "POST /api/sign-in",
      "POST /api/timelines/{timeline}/close",
      "POST /api/timelines/{timeline}/previews",
      "POST /api/timelines/{timeline}/previews/held",
      "POST /api/timelines/{timeline}/previews/press",
      "POST /api/timelines/{timeline}/read",
      "POST /api/uploads",
      "PUT /api/credentials/{name}",
      "PUT /api/networks/{network}",
      "PUT /api/options/{option}",
      "PUT /api/ui/{option}",
    ]);
    expect(new Set(guarded.map(({ security }) => JSON.stringify(security)))).toStrictEqual(
      new Set(['[{"bearer":[]},{"signIn":[]}]'])
    );
    expect(routes.filter(({ route }) => open(route)).map(({ security }) => security)).toStrictEqual(
      [[], [], []]
    );
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

  it("parses an Upload's id as 16 lower-case Crockford base32 characters, and a name of 1 to 1024", () => {
    const upload = Schema.is(UploadId);
    const name = Schema.is(UploadName);

    expect([
      upload("0123456789abcdef"),
      upload("ghjkmnpqrstvwxyz"),
      upload("0123456789ABCDEF"),
      upload("0123456789abcdei"),
      upload("0123456789abcdeu"),
      upload("0123456789abcde"),
      upload("0123456789abcdef0"),
    ]).toStrictEqual([true, true, false, false, false, false, false]);
    expect([
      name("cat.png"),
      name(""),
      name("x".repeat(1024)),
      name("x".repeat(1025)),
    ]).toStrictEqual([true, false, true, false]);
  });

  it("refuses to say text no Line can carry", () => {
    const say = Schema.is(SayRequest);

    expect([
      say({ kind: "Privmsg", target: "#iirc", text: "fine" }),
      say({ kind: "Privmsg", target: "#iirc", text: "two\r\nlines" }),
      say({ kind: "Privmsg", target: "", text: "no target" }),
    ]).toStrictEqual([true, false, false]);
  });

  it("takes the id of the Message a Say answers, and refuses one no tag could carry", () => {
    const say = Schema.decodeUnknownResult(SayRequest);
    const request = { kind: "Privmsg", target: "#iirc", text: "yes" };

    expect(
      [
        "m0",
        "a;b\\c",
        "x".repeat(256),
        "",
        "a b",
        "a\r\nPRIVMSG #other :x",
        "a\u0000b",
        "x".repeat(257),
      ].map((answers) => say({ ...request, answers })._tag)
    ).toStrictEqual([
      "Success",
      "Success",
      "Success",
      "Failure",
      "Failure",
      "Failure",
      "Failure",
      "Failure",
    ]);
    expect(say(request)._tag).toBe("Success");
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

  it("takes a CTCP request or a PING to a nick, with no line break or NUL, and refuses one with nothing to send", () => {
    const act = Schema.decodeUnknownResult(ActRequest);

    expect(
      [
        { action: { _tag: "Ctcp", args: "", command: "VERSION", nick: "peer" } },
        { action: { _tag: "Ctcp", args: "are you there", command: "finger", nick: "peer" } },
        { action: { _tag: "Ping", nick: "peer" } },
        { action: { _tag: "Ctcp", args: "", command: "", nick: "peer" } },
        { action: { _tag: "Ctcp", args: "a\r\nb", command: "PING", nick: "peer" } },
        { action: { _tag: "Ctcp", command: "VERSION", nick: "peer" } },
        { action: { _tag: "Ping", nick: "" } },
        { action: { _tag: "Ping", nick: "a\0" } },
      ].map((each) => act(each)._tag)
    ).toStrictEqual([
      "Success",
      "Success",
      "Success",
      "Failure",
      "Failure",
      "Failure",
      "Failure",
      "Failure",
    ]);
    expect([
      Schema.is(Attempted)({ _tag: "Ctcp", command: "VERSION", nick: "peer" }),
      Schema.is(Attempted)({ _tag: "Ping", nick: "peer" }),
      Schema.is(Attempted)({ _tag: "Ping" }),
    ]).toStrictEqual([true, true, false]);
  });

  it("takes a part of one Channel, with a reason or none, and refuses one with nothing to send", () => {
    const act = Schema.decodeUnknownResult(ActRequest);

    expect(
      [
        { action: { _tag: "Part", channel: "#iirc", reason: null } },
        { action: { _tag: "Part", channel: "#iirc", reason: "bye" } },
        { action: { _tag: "Part", channel: "", reason: null } },
        { action: { _tag: "Part", channel: "#iirc", reason: "a\nb" } },
        { action: { _tag: "Part", channel: "#iirc" } },
      ].map((each) => act(each)._tag)
    ).toStrictEqual(["Success", "Success", "Failure", "Failure", "Failure"]);
    expect([
      Schema.is(Attempted)({ _tag: "Part", channel: "#iirc" }),
      Schema.is(Attempted)({ _tag: "Part" }),
    ]).toStrictEqual([true, false]);
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
      {
        data: '{"at":1,"life":1,"network":"libera","news":[],"sequence":7}',
        event: "happened",
        id: "7",
      },
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
    // A theme imported, its palette all one grey.
    const mine = {
      name: "mine",
      palette: {
        ansi: Array.from({ length: 16 }, () => "#808080"),
        background: "#000000",
        foreground: "#ffffff",
      },
    };

    const option = Schema.decodeUnknownOption(UiOptionName);
    const options = Schema.decodeUnknownOption(UiOptions);
    const set = document.paths["/api/ui/{option}"]?.put;

    expect({
      defaults: uiDefaults,
      names: uiOptionNames,
      option: [
        "conversation.timeFormat",
        "theme",
        "conversation.activity",
        "nope",
        "TIME",
        "time",
      ].map((each) => Option.getOrNull(option(each))),
      options: [
        {
          ...uiDefaults,
          "conversation.activity": "quiet",
          "conversation.timeFormat": "HH:mm:ss",
          theme: "dark",
        },
        { ...uiDefaults, "conversation.activity": "loud", theme: "dark" },
        { "conversation.timeFormat": "HH:mm", theme: "dark" },
        { ...uiDefaults, theme: "tokyo-night" },
        { ...uiDefaults, theme: "Tokyo Night" },
        { ...uiDefaults, "conversation.colors": "raw", "theme.imported": [mine] },
        { ...uiDefaults, "theme.imported": [mine, mine] },
        {
          ...uiDefaults,
          "theme.imported": [{ ...mine, palette: { ...mine.palette, ansi: ["#000000"] } }],
        },
        {
          ...uiDefaults,
          "theme.imported": [{ ...mine, palette: { ...mine.palette, background: "#FFF" } }],
        },
        { ...uiDefaults, font: "jetbrains-mono", "font.size": 10 },
        { ...uiDefaults, font: "atkinson-hyperlegible-mono", "font.size": 24 },
        { ...uiDefaults, font: "system-sans" },
        { ...uiDefaults, font: "inter", "font.size": 16 },
        { ...uiDefaults, "font.size": 9 },
        { ...uiDefaults, "font.size": 25 },
        { ...uiDefaults, "font.size": 14.5 },
        { ...uiDefaults, "font.size": "14" },
        { ...uiDefaults, font: 'Comic "Sans' },
        { ...uiDefaults, "font.lineHeight": 1 },
        { ...uiDefaults, "font.lineHeight": 2 },
        { ...uiDefaults, "font.lineHeight": 1.6 },
        { ...uiDefaults, "font.lineHeight": 0.99 },
        { ...uiDefaults, "font.lineHeight": 2.01 },
        { ...uiDefaults, "font.lineHeight": 1.15 },
        { ...uiDefaults, "font.lineHeight": 1.1 + 0.05 },
        { ...uiDefaults, "font.lineHeight": 1.455 },
        { ...uiDefaults, "font.lineHeight": Number.NaN },
        { ...uiDefaults, "font.lineHeight": Number.POSITIVE_INFINITY },
        { ...uiDefaults, "font.lineHeight": "1.5" },
      ].map((each) => Option.isSome(options(each))),
      statuses: Object.keys(set?.responses ?? {}).toSorted(),
      value: [{ value: "dark" }, { value: { any: ["json", 1] } }, {}, { other: 2, value: 1 }].map(
        (each) => Option.isSome(Schema.decodeUnknownOption(UiValue, requestParseOptions)(each))
      ),
    }).toStrictEqual({
      defaults: {
        aliases: [],
        "conversation.activity": "all",
        "conversation.colors": "theme",
        "conversation.dateFormat": "full",
        "conversation.layout": "columns",
        "conversation.maxWidth": "none",
        "conversation.nickBrackets": true,
        "conversation.nickPrefix": true,
        "conversation.nickWidth": 16,
        "conversation.spacing": 0.3,
        "conversation.timeFormat": "HH:mm",
        font: "system",
        "font.lineHeight": 1.45,
        "font.size": 14,
        "input.enter": "send",
        "input.nickSuffix": ": ",
        "input.spellcheck": true,
        logs: "info",
        "members.width": 18,
        previews: "off",
        "previews.animate": true,
        "previews.conversations": {},
        "previews.mediaHeight": "medium",
        "previews.players": [
          "www.youtube-nocookie.com",
          "player.vimeo.com",
          "w.soundcloud.com",
          "bandcamp.com",
          "open.spotify.com",
          "player.twitch.tv",
        ],
        "previews.start": "open",
        "sidebar.networks": [],
        "sidebar.order": [],
        "sidebar.pinned": [],
        theme: "system",
        "theme.dark": "dark",
        "theme.imported": [],
        "theme.light": "light",
        "unread.markRead": "latest",
        "unread.muted": [],
        "unread.quietBots": false,
      },
      names: [
        "aliases",
        "conversation.activity",
        "conversation.colors",
        "conversation.dateFormat",
        "conversation.layout",
        "conversation.maxWidth",
        "conversation.nickBrackets",
        "conversation.nickPrefix",
        "conversation.nickWidth",
        "conversation.spacing",
        "conversation.timeFormat",
        "font",
        "font.lineHeight",
        "font.size",
        "input.enter",
        "input.nickSuffix",
        "input.spellcheck",
        "logs",
        "members.width",
        "previews",
        "previews.animate",
        "previews.conversations",
        "previews.mediaHeight",
        "previews.players",
        "previews.start",
        "sidebar.networks",
        "sidebar.order",
        "sidebar.pinned",
        "theme",
        "theme.dark",
        "theme.imported",
        "theme.light",
        "unread.markRead",
        "unread.muted",
        "unread.quietBots",
      ],
      option: ["conversation.timeFormat", "theme", "conversation.activity", null, null, null],
      options: [
        true,
        false,
        false,
        true,
        false,
        true,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        true,
        true,
        true,
        false,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
      ],
      statuses: ["200", "400", "401", "403", "409", "500"],
      value: [true, true, false, false],
    });
  });

  it("reads a ui option's name kept as the option it names, and no other", () => {
    expect(
      ["font.size", "size", "time", "conversation.timeFormat", "nope", ""].map(uiNameKept)
    ).toStrictEqual([
      "font.size",
      undefined,
      undefined,
      "conversation.timeFormat",
      undefined,
      undefined,
    ]);
  });

  it("takes aliases as names of lower-case words that each stand for one command line, each named once, at most 64, and keeps the good of a value refused whole", () => {
    const aliases = Schema.decodeUnknownOption(Aliases);
    const line = Schema.decodeUnknownOption(AliasLine);
    const name = Schema.decodeUnknownOption(AliasName);
    const mine = { line: "/join $1", name: "j" };

    const many = uiValueKept("aliases", numbered(70));

    expect({
      cap: [64, 65].map((count) => Option.isSome(aliases(numbered(count)))),
      default: uiDefaults.aliases,
      kept: [
        uiValueKept("aliases", [
          mine,
          { line: "/me $*", name: "Bad Name" },
          { ...mine, line: "/x" },
        ]),
        Array.isArray(many) ? many.length : undefined,
        uiValueKept("aliases", "j"),
        uiValueKept("aliases", [mine]),
      ],
      lines: [
        "/join $1",
        "/me $*",
        "/x",
        "",
        "join #a",
        "//join",
        "/",
        "/ join",
        " /join",
        "/join ",
        "/join\n/part",
        "/join\u0000",
        `/${"x".repeat(511)}`,
        `/${"x".repeat(512)}`,
        "/join \uD800",
        "/$*",
        "/join\u00A0$1",
        "/j$1",
      ].map((each) => Option.isSome(line(each))),
      names: [
        "j",
        "join-quiet",
        "a1",
        "x".repeat(32),
        "J",
        "-j",
        "j-",
        "j--k",
        "",
        "x".repeat(33),
        "j k",
      ].map((each) => Option.isSome(name(each))),
      option: Option.isSome(Schema.decodeOption(UiOptions)({ ...uiDefaults, aliases: [mine] })),
      twice: Option.isSome(aliases([mine, mine])),
    }).toStrictEqual({
      cap: [true, false],
      default: [],
      kept: [[mine], 64, undefined, [mine]],
      lines: [
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
      ],
      names: [true, true, true, true, false, false, false, false, false, false, false],
      option: true,
      twice: false,
    });
  });

  it("takes a font by name, or a family by its own name that is always one quoted CSS family, and refuses the rest", () => {
    expect({
      families: [
        "Fira Code",
        "DejaVu Sans Mono",
        "Noto Sans CJK JP",
        "思源黑体",
        "x".repeat(64),
      ].map(font),
      // A name served is one, never a family, and in another case it is neither, so each
      // font has one value.
      named: ["system", "inter", "ibm-plex-mono"].map((each) => {
        const decoded = font(each);

        return decoded === null ? null : isFontName(decoded);
      }),
      namedInAnotherCase: ["Inter", "SYSTEM", "IBM-Plex-Mono", "System-Sans"].map(font),
      refused: [
        "",
        " ",
        " Fira Code",
        "Fira Code ",
        'Fira" Code',
        String.raw`Fira\ Code`,
        String.raw`Fira\22 Code`,
        "Fira\nCode",
        "Fira\u0000Code",
        "Fira\u007FCode",
        "Fira\u0085Code",
        "Fira\uD800Code",
        "x".repeat(65),
        42,
        null,
      ].map(font),
    }).toStrictEqual({
      families: ["Fira Code", "DejaVu Sans Mono", "Noto Sans CJK JP", "思源黑体", "x".repeat(64)],
      named: [true, true, true],
      namedInAnotherCase: [null, null, null, null],
      refused: Array.from({ length: 15 }, () => null),
    });
  });

  it("reads ui.previews.start kept as summary or chip as closed, and open as open", () => {
    expect(
      ["open", "summary", "chip", "closed", "folded"].map((value) =>
        uiValueKept("previews.start", value)
      )
    ).toStrictEqual(["open", "closed", "closed", "closed", undefined]);
  });

  it("reads Previews journaled as links only as text, in ui.previews and in each Timeline's own", () => {
    const one = "00000000000002-00000000-00000000";
    const two = "00000000000003-00000000-00000000";

    expect({
      byTimeline: uiValueKept("previews.conversations", { [one]: "links only", [two]: "on" }),
      byTimelineRefused: uiValueKept("previews.conversations", { [one]: "links" }),
      shown: ["links only", "text", "on", "links", "Links Only"].map((each) =>
        uiValueKept("previews", each)
      ),
    }).toStrictEqual({
      byTimeline: { [one]: "text", [two]: "on" },
      byTimelineRefused: undefined,
      shown: ["text", "text", "on", undefined, undefined],
    });
  });

  it("reads a font journaled before as it was, and a family as written, as plain text both ways", () => {
    const codec = Schema.toCodecJson(UiOptions.fields.font);

    expect({
      kept: ["system", "ibm-plex-mono", "inter", "Fira Code", "Inter", 'a"b'].map((each) =>
        uiValueKept("font", each)
      ),
      wire: ["system", "ibm-plex-mono", "Fira Code"].map((each) =>
        Schema.encodeSync(codec)(Schema.decodeSync(codec)(each))
      ),
    }).toStrictEqual({
      kept: ["system", "ibm-plex-mono", "inter", "Fira Code", undefined, undefined],
      wire: ["system", "ibm-plex-mono", "Fira Code"],
    });
  });

  it("takes the nick column and the members' panel each as a whole count of characters within its bounds, and no other", () => {
    const tried = [10, 11, 16, 18, 40, 41, 13, 14, 16.5, Number.NaN, "16", null];
    const nick = Schema.decodeUnknownOption(NickWidth);
    const members = Schema.decodeUnknownOption(MembersWidth);

    expect({
      members: tried.map((each) => Option.getOrNull(members(each))),
      nick: tried.map((each) => Option.getOrNull(nick(each))),
    }).toStrictEqual({
      members: [null, null, 16, 18, 40, null, null, 14, null, null, null, null],
      nick: [null, 11, 16, 18, 40, null, 13, 14, null, null, null, null],
    });
  });

  it("takes the room between rows as a multiple of the text's size from 0 to 1.5 in twentieths, and no other", () => {
    const spacing = Schema.decodeUnknownOption(RowSpacing);

    expect(
      [0, 0.05, 0.3, 1, 1.5, 0.15, -0.05, 1.55, 0.31, 0.1 + 0.05, Number.NaN, "0.3", null].map(
        (each) => Option.getOrNull(spacing(each))
      )
    ).toStrictEqual([0, 0.05, 0.3, 1, 1.5, 0.15, null, null, null, null, null, null, null]);
  });

  it("takes the widest line as none or a whole count of characters from 40 to 400, and no other", () => {
    const widest = Schema.decodeUnknownOption(WidestLine);

    expect(
      [
        "none",
        40,
        80,
        400,
        39,
        401,
        0,
        -80,
        80.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "80",
        "None",
        "auto",
        "",
        null,
      ].map((each) => Option.getOrNull(widest(each)))
    ).toStrictEqual([
      "none",
      40,
      80,
      400,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("takes when a Timeline is marked read: shown, latest, or asked, and nothing else", () => {
    const read = Schema.decodeUnknownOption(ReadRule);

    expect(
      ["shown", "latest", "asked", "Latest", "never", "", null].map((each) =>
        Option.getOrNull(read(each))
      )
    ).toStrictEqual(["shown", "latest", "asked", null, null, null, null]);
  });

  it("takes a line's layout as columns, inline, or stacked, columns to start, and nothing else", () => {
    const layout = Schema.decodeUnknownOption(LineLayout);

    expect({
      layout: ["columns", "inline", "stacked", "Stacked", "", null].map((each) =>
        Option.getOrNull(layout(each))
      ),
      start: uiDefaults["conversation.layout"],
    }).toStrictEqual({
      layout: ["columns", "inline", "stacked", null, null, null],
      start: "columns",
    });
  });

  it("takes the Composer's habits: what Enter does, spellcheck, and a short suffix with no control character", () => {
    const enter = Schema.decodeUnknownOption(EnterKey);
    const spellcheck = Schema.decodeUnknownOption(SpellcheckShown);
    const suffix = Schema.decodeUnknownOption(NickSuffix);

    expect({
      enter: ["send", "newline", "Send", "shift", "", null].map((each) =>
        Option.getOrNull(enter(each))
      ),
      spellcheck: [true, false, "on", 1, null].map((each) => Option.getOrNull(spellcheck(each))),
      suffix: [
        ": ",
        "",
        " ",
        ", ",
        "x".repeat(nickSuffixMaxLength),
        "x".repeat(nickSuffixMaxLength + 1),
        ":\n",
        ":\r",
        "\u0003",
        "\u000F",
        "\u007F",
        "\u0085",
        "\uD800",
        "→ ",
        1,
        null,
      ].map((each) => Option.getOrNull(suffix(each))),
    }).toStrictEqual({
      enter: ["send", "newline", null, null, null, null],
      spellcheck: [true, false, null, null, null],
      suffix: [
        ": ",
        "",
        " ",
        ", ",
        "x".repeat(nickSuffixMaxLength),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "→ ",
        null,
        null,
      ],
    });
  });

  it("carries the ui options whole with the last Change's sequence as the event id, from 0 for none", () => {
    const wire = [
      {
        data: '{"options":{"aliases":[],"conversation.activity":"all","conversation.colors":"theme","conversation.dateFormat":"full","conversation.layout":"columns","conversation.maxWidth":"none","conversation.nickBrackets":true,"conversation.nickPrefix":true,"conversation.nickWidth":16,"conversation.spacing":0.3,"conversation.timeFormat":"HH:mm","font":"system","font.lineHeight":1.45,"font.size":14,"input.enter":"send","input.nickSuffix":": ","input.spellcheck":true,"logs":"info","members.width":18,"previews":"off","previews.animate":true,"previews.conversations":{},"previews.mediaHeight":"medium","previews.players":["www.youtube-nocookie.com","player.vimeo.com","w.soundcloud.com","bandcamp.com","open.spotify.com","player.twitch.tv"],"previews.start":"open","sidebar.networks":[],"sidebar.order":[],"sidebar.pinned":[],"theme":"system","theme.dark":"dark","theme.imported":[],"theme.light":"light","unread.markRead":"latest","unread.muted":[],"unread.quietBots":false},"sequence":0}',
        event: "changed",
        id: "0",
      },
      {
        data: '{"options":{"aliases":[],"conversation.activity":"quiet","conversation.colors":"theme","conversation.dateFormat":"full","conversation.layout":"columns","conversation.maxWidth":"none","conversation.nickBrackets":true,"conversation.nickPrefix":true,"conversation.nickWidth":16,"conversation.spacing":0.3,"conversation.timeFormat":"HH:mm:ss","font":"ibm-plex-mono","font.lineHeight":1.45,"font.size":16,"input.enter":"newline","input.nickSuffix":", ","input.spellcheck":false,"logs":"info","members.width":18,"previews":"off","previews.animate":true,"previews.conversations":{},"previews.mediaHeight":"medium","previews.players":["www.youtube-nocookie.com","player.vimeo.com","w.soundcloud.com","bandcamp.com","open.spotify.com","player.twitch.tv"],"previews.start":"open","sidebar.networks":[],"sidebar.order":[],"sidebar.pinned":[],"theme":"dark","theme.dark":"dark","theme.imported":[],"theme.light":"light","unread.markRead":"latest","unread.muted":[],"unread.quietBots":false},"sequence":9}',
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
    const data = {
      dropped: [],
      gaps: [],
      items: [],
      merged: [],
      removals: [],
      sequence: 9,
      timelines: [],
    };

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

  it("marks every field of a Lookup's profile a Network wrote as Untrusted", () => {
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const nullable = `{"anyOf":[${untrusted},{"type":"null"}]}`;
    const looked = JSON.stringify(document.paths["/api/networks/{network}/lookups/{intent}"]);

    expect(
      [
        `"account":${nullable}`,
        `"away":${nullable}`,
        `"host":${nullable}`,
        `"nick":${untrusted}`,
        `"realname":${nullable}`,
        `"user":${nullable}`,
        `"properties":{"info":${untrusted},"name":${untrusted}}`,
        `"properties":{"name":${untrusted},"prefixes":{"type":"array","items":${untrusted}}}`,
        `"properties":{"numeric":${untrusted},"params":{"type":"array","items":${untrusted}}}`,
        `"reply":${untrusted}},"required":["_tag","notes","reply"]`,
        `"context":{"type":"array","items":${untrusted}}`,
      ].filter((field) => !looked.includes(field))
    ).toStrictEqual([]);
  });

  it("carries a Channel's list asked, and its masks, with who set each and when only where said", () => {
    const asked = { intent: "c1", lookup: { _tag: "Exceptions", channel: "#iirc" } } as const;

    const listed = {
      _tag: "Listed",
      cut: "Bounded",
      masks: [
        { mask: "a!*@*", setAt: Instant.make(1_767_225_600_000), setBy: "peer" },
        { mask: "b!*@*", setAt: null, setBy: null },
      ],
      notes: [],
    } as const;

    const whole = { ...listed, cut: null, masks: [] };
    const refused = { _tag: "Refused", reason: "NotOffered" } as const;
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const looked = JSON.stringify(document.paths["/api/networks/{network}/lookups/{intent}"]);

    expect([
      Schema.decodeSync(LookRequest)(asked),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(listed)),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(whole)),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(refused)),
      Schema.is(LookRequest)({ lookup: { _tag: "Bans", channel: "#a\r\nQUIT" } }),
      Schema.is(LookRequest)({ lookup: { _tag: "Bans", channel: "" } }),
      [`"mask":${untrusted}`, `"setBy":{"anyOf":[${untrusted},{"type":"null"}]}`].filter(
        (field) => !looked.includes(field)
      ),
    ]).toStrictEqual([asked, listed, whole, refused, false, false, []]);
  });

  it("carries a Channel's members and the Users a mask matched, each with its cut, and an empty list whole", () => {
    const names = { intent: "n1", lookup: { _tag: "Names", channel: "#iirc" } } as const;
    const who = { intent: "w1", lookup: { _tag: "Who", mask: "peer*" } } as const;

    const members = {
      _tag: "Members",
      cut: "Bounded",
      members: [
        { nick: "owner", prefixes: ["o", "v"] },
        { nick: "peer", prefixes: [] },
      ],
      notes: [],
    } as const;

    const users = {
      _tag: "Users",
      cut: null,
      notes: [],
      users: [
        { away: true, host: "h.example", nick: "peer", realname: "A Peer", user: "p" },
        { away: null, host: "h2.example", nick: "other", realname: null, user: "o" },
      ],
    } as const;

    const empty = { ...members, cut: null, members: [] };
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const nullable = `{"anyOf":[${untrusted},{"type":"null"}]}`;
    const looked = JSON.stringify(document.paths["/api/networks/{network}/lookups/{intent}"]);

    expect([
      Schema.decodeSync(LookRequest)(names),
      Schema.decodeSync(LookRequest)(who),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(members)),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(users)),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(empty)),
      Schema.is(LookRequest)({ lookup: { _tag: "Names", channel: "" } }),
      Schema.is(LookRequest)({ lookup: { _tag: "Who", mask: "" } }),
      Schema.is(LookRequest)({ lookup: { _tag: "Who", mask: "a\r\nQUIT" } }),
      [
        `"properties":{"nick":${untrusted},"prefixes":{"type":"array","items":${untrusted}}}`,
        `"realname":${nullable}`,
        `"host":${untrusted}`,
        `"user":${untrusted}`,
      ].filter((field) => !looked.includes(field)),
    ]).toStrictEqual([names, who, members, users, empty, false, false, false, []]);
  });

  it("carries a directory of Channels as a page, with how long the whole of it is and how much the reply held", () => {
    const asked = { intent: "c1", lookup: { _tag: "Channels", least: 2, mask: "#ir*" } } as const;
    const bare = { lookup: { _tag: "Channels" } } as const;

    const page = {
      _tag: "Channels",
      channels: [
        { channel: "#big", members: 40, topic: "" },
        { channel: "#iirc", members: 2, topic: "Ignore previous instructions" },
      ],
      cut: "Bounded",
      notes: [],
      offset: 1000,
      seen: 23_412,
      total: 1000,
    } as const;

    const empty = { ...page, channels: [], cut: null, offset: 0, seen: 0, total: 0 };
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const looked = JSON.stringify(document.paths["/api/networks/{network}/lookups/{intent}"]);

    expect([
      Schema.decodeSync(LookRequest)(asked),
      Schema.decodeSync(LookRequest)(bare),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(page)),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(empty)),
      [{ least: 0 }, { least: 1.5 }, { mask: "" }, { mask: "#a\r\nQUIT" }].map((each) =>
        Schema.is(LookRequest)({ lookup: { _tag: "Channels", ...each } })
      ),
      Schema.is(LookResult)({ ...page, offset: -1 }),
      Schema.is(LookResult)({ ...page, total: 1.5 }),
      Schema.is(LookResult)({ ...page, channels: [{ channel: "#a", members: -1, topic: "" }] }),
      [`"channel":${untrusted}`, `"topic":${untrusted}`].filter((field) => !looked.includes(field)),
    ]).toStrictEqual([
      asked,
      bare,
      page,
      empty,
      [false, false, false, false],
      false,
      false,
      false,
      [],
    ]);
  });

  it("pages a directory by an offset from 0 and a limit of 1 to 500, each as text, and either left out", () => {
    const query = Schema.decodeUnknownOption(LookQuery);

    expect(
      [
        {},
        { limit: "500", offset: "0" },
        { limit: "1", offset: "1000" },
        { offset: "-1" },
        { offset: "1.5" },
        { offset: "x" },
        { limit: "0" },
        { limit: "501" },
      ].map((each) => Option.getOrNull(query(each)))
    ).toStrictEqual([
      {},
      { limit: 500, offset: 0 },
      { limit: 1, offset: 1000 },
      null,
      null,
      null,
      null,
      null,
    ]);

    expect([
      parameters("/api/networks/{network}/lookups", "post"),
      parameters("/api/networks/{network}/lookups/{intent}", "get"),
    ]).toStrictEqual(
      Array.from({ length: 2 }, () => [
        ["limit", false],
        ["offset", false],
      ])
    );
  });

  it("carries a standard reply and a Lookup's notes whole, each field its own, and only the three kinds", () => {
    const reply = {
      code: "SLOW",
      command: "WHOIS",
      context: ["peer", "*"],
      description: "Took a while",
      kind: "WARN",
    } as const;

    const activity = { _tag: "StandardReply", ...reply } as const;
    const result = { _tag: "Found", notes: [reply], profiles: [] } as const;
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const looked = JSON.stringify(document.paths["/api/networks/{network}/lookups/{intent}"]);

    expect([
      Schema.decodeSync(Activity)(Schema.encodeSync(Activity)(activity)),
      Schema.decodeSync(LookResult)(Schema.encodeSync(LookResult)(result)),
      Schema.is(Activity)({ ...activity, kind: "INFO" }),
      [`"code":${untrusted}`, `"command":${untrusted}`, `"description":${untrusted}`].filter(
        (field) => !looked.includes(field)
      ),
    ]).toStrictEqual([activity, result, false, []]);
  });

  it("carries a CTCP request with its answer, a reply, and an answer that never left, each field its own, every word Untrusted", () => {
    const request = {
      _tag: "CtcpRequest",
      answer: { _tag: "Answered", text: "1 2" },
      args: "1 2",
      command: "PING",
      nick: "peer",
      target: "iirc",
    } as const;

    const refused = { ...request, answer: { _tag: "Unanswered", reason: "Limited" } } as const;

    const reply = {
      _tag: "CtcpReply",
      args: "irssi",
      command: "VERSION",
      nick: "peer",
      roundTrip: null,
      target: "iirc",
    } as const;

    const pong = { ...reply, args: "1767225600000", command: "PING", roundTrip: 250 } as const;
    const unsent = { _tag: "CtcpUnsent", command: "PING", nick: "peer", target: "iirc" } as const;

    const sent = {
      _tag: "CtcpSent",
      args: "1767225600000",
      command: "PING",
      nick: "peer",
    } as const;

    expect([
      roundTrip(request),
      roundTrip(refused),
      roundTrip(reply),
      roundTrip(pong),
      roundTrip(unsent),
      roundTrip(sent),
      Schema.is(Activity)({ ...refused, answer: { _tag: "Unanswered", reason: "Bored" } }),
      Schema.is(Activity)({ ...pong, roundTrip: -1 }),
      Schema.is(Activity)({ ...pong, roundTrip: 0.5 }),
    ]).toStrictEqual([request, refused, reply, pong, unsent, sent, false, false, false]);
  });

  it("carries what a Message answers, a Direct Message's Channel, and what an item answers, every word Untrusted", () => {
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const text = JSON.stringify(document);
    const position = { at: Instant.make(1_762_560_000_000), n: 0, sequence: 3 };
    const cursor = cursorOf(position);

    const encoded: typeof TimelineItem.Encoded = {
      answered: { kind: "Privmsg", position: cursor, sender: "peer", text: "hello" },
      changed: 4,
      content: {
        _tag: "Message",
        answers: "m1",
        at: { _tag: "Unknown" },
        bot: false,
        context: "#iirc",
        id: { _tag: "Unknown" },
        kind: "Privmsg",
        live: true,
        nicks: [{ end: 2, start: 0 }],
        ours: null,
        prefix: null,
        sender: "pal",
        tags: [{ key: "+reply", value: "m1" }],
        target: "iirc",
        text: "hi",
      },
      level: "Highlight",
      network: "libera",
      position: cursor,
      sequence: 4,
      timeline: timelineIdOf(1, 0, 1),
    };

    const decoded = Schema.decodeSync(TimelineItem)(encoded);

    expect([
      decoded.answered?.position,
      Schema.encodeSync(TimelineItem)(decoded),
      Schema.decodeSync(TimelineItem)({ ...encoded, answered: null }).answered,
      text.includes(
        `"sender":${untrusted},"text":${untrusted}},"required":["kind","position","sender","text"]`
      ),
      text.includes('"answers":{"anyOf":[{"$ref":"#/components/schemas/UntrustedMessageId"}'),
      text.includes(`"context":{"anyOf":[${untrusted}`),
    ]).toStrictEqual([position, encoded, null, true, true, true]);
  });

  it("marks every nick, mode, and symbol of a Channel's members as Untrusted, never a key", () => {
    const untrusted = '{"$ref":"#/components/schemas/Untrusted"}';
    const head = JSON.stringify(document.paths["/api/timelines/{timeline}/channel"]);
    const members = JSON.stringify(document.paths["/api/timelines/{timeline}/members"]);

    const page = Schema.encodeSync(MemberPage)({
      members: [
        {
          account: { _tag: "Known", at: Instant.make(0), from: "ircd", value: "bobby" },
          away: { _tag: "Unknown" },
          bot: { _tag: "Unknown" },
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
      members.includes(`"account":`) &&
        members.includes(`"value":{"anyOf":[${untrusted},{"type":"null"}]}`),
      members.includes(`"atLeast":{"type":"array","items":${untrusted}}`),
      page.members.map((one) => [Object.keys(one).toSorted(), one.nick]),
    ]).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      [[["account", "away", "bot", "nick", "prefixes"], "__proto__"]],
    ]);
  });
});
