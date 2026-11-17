import { NetworkId, TimelineId } from "@iirc/api";
import { OwnerOptions, ownerDefaults, ownerOptionNames } from "@iirc/api/options";
import type { OwnerInForce } from "@iirc/api/options";
import { FontFamily, UiOptions } from "@iirc/api/ui";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { IgnoreMask } from "@iirc/protocol/mask";
import { Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { interpret, typesCredential } from "./commands.ts";
import type { CommandContext, Intent } from "./commands.ts";
import { submit, initialComposers, reduceComposers, draftOf } from "./composer.ts";
import {
  apply,
  credentialFor,
  derivedCredential,
  derivedOwnerCredential,
  fields,
  initialOptions,
  listed,
  matches,
  optionsOf,
  ownerCredentialFor,
  ownerFields,
  ownerOptionsOf,
  parseOwnerText,
  parseText,
  reduceOptions,
  resolve,
  resolveOwner,
  set,
  showText,
  starting,
  uiFields,
  uiOptionsOf,
  fontMissing,
  unset,
} from "./options.ts";
import type { Configuration, Edit, Json, Kind, NetworkOption, OptionsEvent } from "./options.ts";

const libera = Schema.decodeSync(NetworkId)("libera");
const dotted = Schema.decodeSync(NetworkId)("my.net");
const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");
const decode = Schema.decodeSync(NetworkConfiguration);

const plain: Configuration = decode({
  answerCtcp: true,
  channels: [{ name: "#iirc" }],
  declined: [],
  enabled: true,
  fallbackEncoding: "windows-1252",
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  login: { _tag: "None" },
  nicks: ["dean", "dean_"],
  realname: "Dean",
  username: "dean",
});

const full: Configuration = decode({
  ...plain,
  channels: [{ key: "libera.channels._23secret.key", name: "#secret" }, { name: "#iirc" }],
  login: { _tag: "Sasl", account: "dean", credential: "libera.sasl", required: true },
  password: "libera.password",
});

const valueOf = (read: ReturnType<typeof set>) => {
  if (read._tag === "Invalid") {
    throw new Error(read.message);
  }

  return read.value;
};

const inChannel: CommandContext = {
  behind: false,
  draft: undefined,
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network: libera,
    removed: false,
    timeline,
  },
  head: undefined,
  open: timeline,
  panes: 1,
  session: false,
  shown: [],
  timelines: [timeline],
  unread: [],
  unreadClosed: [],
};

const nowhere: CommandContext = {
  behind: false,
  draft: undefined,
  focus: undefined,
  head: undefined,
  open: undefined,
  panes: 1,
  session: false,
  shown: [],
  timelines: [],
  unread: [],
  unreadClosed: [],
};

const read = (line: string, context: CommandContext = nowhere) => interpret(line, context);

describe("the options, derived from the Schema", () => {
  it("has a field for every field of the Configuration, each described, with its kind", () => {
    const keys = Object.keys(NetworkConfiguration.fields).toSorted();

    expect({
      described: fields.every((field) => field.description !== ""),
      keys: fields.map((field) => field.key).toSorted(),
      kinds: Object.fromEntries(fields.map((field) => [field.key, field.kind._tag])),
    }).toStrictEqual({
      described: true,
      keys,
      kinds: {
        answerCtcp: "Toggle",
        channels: "Names",
        declined: "Texts",
        enabled: "Toggle",
        fallbackEncoding: "Choice",
        highlights: "Texts",
        ignores: "Texts",
        ircds: "Ircds",
        login: "Tagged",
        nicks: "Texts",
        oper: "Tagged",
        password: "Credential",
        realname: "Text",
        username: "Text",
      },
    });
  });

  it("lists every option, members' and records' fields under their names, each reachable by its name", () => {
    const options = optionsOf(libera, full, new Set(["libera.sasl"]));
    const names = options.map((option) => option.name);

    expect({
      names,
      resolved: names.every((name) => resolve(name)._tag === "Parsed"),
    }).toStrictEqual({
      names: [
        "network.libera.answerCtcp",
        "network.libera.channels",
        "network.libera.channels.#secret.key",
        "network.libera.channels.#iirc.key",
        "network.libera.declined",
        "network.libera.enabled",
        "network.libera.fallbackEncoding",
        "network.libera.highlights",
        "network.libera.ignores",
        "network.libera.ircds",
        "network.libera.login",
        "network.libera.login.account",
        "network.libera.login.credential",
        "network.libera.login.required",
        "network.libera.login.service",
        "network.libera.login.wait",
        "network.libera.nicks",
        "network.libera.oper",
        "network.libera.oper.credential",
        "network.libera.oper.name",
        "network.libera.password",
        "network.libera.realname",
        "network.libera.username",
      ],
      resolved: true,
    });
  });

  it("shows each value in its syntax, and what a new Network starts with", () => {
    const shown = Object.fromEntries(
      optionsOf(libera, full, new Set(["libera.sasl"])).map((option) => [
        option.name.slice("network.libera.".length),
        { starts: option.starts, value: option.value },
      ])
    );

    expect(shown).toStrictEqual({
      answerCtcp: { starts: "on", value: { _tag: "Shown", text: "on" } },
      channels: { starts: "", value: { _tag: "Shown", text: "#secret,#iirc" } },
      "channels.#iirc.key": { starts: "unset", value: { _tag: "Unset" } },
      "channels.#secret.key": {
        starts: "unset",
        value: { _tag: "Credential", held: false, name: "libera.channels._23secret.key" },
      },
      declined: { starts: "", value: { _tag: "Shown", text: "" } },
      enabled: { starts: "on", value: { _tag: "Shown", text: "on" } },
      fallbackEncoding: {
        starts: "windows-1252",
        value: { _tag: "Shown", text: "windows-1252" },
      },
      highlights: { starts: "", value: { _tag: "Shown", text: "" } },
      ignores: { starts: "", value: { _tag: "Shown", text: "" } },
      ircds: { starts: undefined, value: { _tag: "Shown", text: "irc.libera.chat/6697" } },
      login: { starts: "none", value: { _tag: "Shown", text: "sasl" } },
      "login.account": { starts: "the first nick", value: { _tag: "Shown", text: "dean" } },
      "login.credential": {
        starts: "libera.login.credential",
        value: { _tag: "Credential", held: true, name: "libera.sasl" },
      },
      "login.required": { starts: "off", value: { _tag: "Shown", text: "on" } },
      "login.service": { starts: "NickServ", value: { _tag: "Unset" } },
      "login.wait": { starts: "5", value: { _tag: "Unset" } },
      nicks: { starts: undefined, value: { _tag: "Shown", text: "dean,dean_" } },
      oper: { starts: "none", value: { _tag: "Shown", text: "none" } },
      "oper.credential": { starts: "libera.oper.credential", value: { _tag: "Unset" } },
      "oper.name": { starts: "the first nick", value: { _tag: "Unset" } },
      password: {
        starts: "unset",
        value: { _tag: "Credential", held: false, name: "libera.password" },
      },
      realname: { starts: "the first nick", value: { _tag: "Shown", text: "Dean" } },
      username: { starts: "the first nick", value: { _tag: "Shown", text: "dean" } },
    });
  });

  it("never shows a Credential option's value, only its name and whether it is held", () => {
    const credentials = optionsOf(libera, full, undefined).filter(
      (option) => option.kind._tag === "Credential"
    );

    expect(credentials.map((option) => option.value._tag)).toStrictEqual([
      "Credential",
      "Unset",
      "Credential",
      "Unset",
      "Credential",
    ]);
  });

  it("shows a member's fields unset while another member is in force", () => {
    const login = optionsOf(libera, plain, undefined).filter((option) =>
      option.name.startsWith("network.libera.login.")
    );

    expect(login.map((option) => option.value)).toStrictEqual([
      { _tag: "Unset" },
      { _tag: "Unset" },
      { _tag: "Unset" },
      { _tag: "Unset" },
      { _tag: "Unset" },
    ]);
  });

  it("shows a service login's fields, sharing the account and Credential with SASL's", () => {
    const service = decode({
      ...plain,
      login: {
        _tag: "Service",
        account: "dean",
        credential: "libera.login.credential",
        service: "NickServ",
        wait: 5,
      },
    });

    const login = optionsOf(libera, service, new Set(["libera.login.credential"])).filter(
      (option) => option.name.startsWith("network.libera.login")
    );

    expect(login.map((option) => [option.name, option.value])).toStrictEqual([
      ["network.libera.login", { _tag: "Shown", text: "service" }],
      ["network.libera.login.account", { _tag: "Shown", text: "dean" }],
      [
        "network.libera.login.credential",
        { _tag: "Credential", held: true, name: "libera.login.credential" },
      ],
      ["network.libera.login.required", { _tag: "Unset" }],
      ["network.libera.login.service", { _tag: "Shown", text: "NickServ" }],
      ["network.libera.login.wait", { _tag: "Shown", text: "5" }],
    ]);
  });
});

const at = (name: string) => {
  const found = resolve(name);

  return found._tag === "Parsed" ? [found.value.network, ...found.value.path] : found.message;
};

describe("names", () => {
  it("resolve a Network's id with dots, a Channel's name with dots, and nothing else", () => {
    expect({
      channel: at("network.libera.channels.#a.b.key"),
      dotted: at("network.my.net.nicks"),
      member: at("network.my.net.login.account"),
      noNetwork: at("libera.nicks"),
      none: at("network.libera.nope"),
      uppercase: at("network.Libera.nicks"),
    }).toStrictEqual({
      channel: ["libera", "channels", "#a.b", "key"],
      dotted: [dotted, "nicks"],
      member: [dotted, "login", "account"],
      noNetwork:
        "There is no option libera.nicks. Options are named network.<id>.<option>, ui.<option>, store.<option>, uploads.<option>, or previews.<option>.",
      none: "There is no option network.libera.nope.",
      uppercase: "There is no option network.Libera.nicks.",
    });
  });

  it("derive a Credential's name from the option's, escaping what a name cannot hold", () => {
    expect({
      channel: derivedCredential(libera, ["channels", "#a_b", "key"]),
      kept: credentialFor(libera, full, ["login", "credential"]),
      long: derivedCredential("x".repeat(60), ["password"])._tag,
      sasl: derivedCredential(libera, ["login", "credential"]),
    }).toStrictEqual({
      channel: { _tag: "Parsed", value: "libera.channels._23a_5fb.key" },
      kept: { _tag: "Parsed", value: "libera.sasl" },
      long: "Invalid",
      sasl: { _tag: "Parsed", value: "libera.login.credential" },
    });
  });

  it("match a pattern with * anywhere, or text found anywhere, in any case", () => {
    const name = "network.libera.nicks";

    expect(
      ["network.libera.*", "*nick*", "NICK", "*.nicks", "network.*.nicks", "*oftc*", "x*", ""].map(
        (filter) => matches(filter, name)
      )
    ).toStrictEqual([true, true, true, true, true, false, false, true]);
  });
});

// Any text the Schema admits, weighted towards what a syntax must escape or keep: quotes,
// commas, backslashes, spaces at either edge, and characters beyond ASCII.
const anyText = fc.oneof(
  fc.string({ unit: "binary" }),
  fc
    .array(
      fc.constantFrom('"', ",", "\\", " ", "a", "é", "日", "🐱", "/", "-tls", " plain", "\t"),
      {
        maxLength: 8,
      }
    )
    .map((parts) => parts.join(""))
);

const host = anyText.filter((text) => text !== "");
const simpleHost = fc.stringMatching(/^[a-z0-9.:-]{1,20}$/u);

// fast-check makes records with no prototype, which a plain object never equals.
const ircd = fc
  .record({ host, port: fc.integer({ max: 65_535, min: 1 }), tls: fc.boolean() })
  .map((one) => ({ ...one }));

const kindOf = (key: string): Kind => {
  const field = fields.find((one) => one.key === key);

  if (field === undefined) {
    throw new Error(`no field ${key}`);
  }

  return field.kind;
};

const choices = (key: string) => {
  const kind = kindOf(key);

  return kind._tag === "Choice" ? kind.choices : [];
};

// Each value, and what its syntax reads back: a keyed list its names, a union its tag.
const same = (arbitrary: fc.Arbitrary<Json>) =>
  arbitrary.map((value): readonly [Json, Json] => [value, value]);

const values: readonly (readonly [string, fc.Arbitrary<readonly [Json, Json]>])[] = [
  ["enabled", same(fc.boolean())],
  ["realname", same(anyText)],
  ["fallbackEncoding", same(fc.constantFrom(...choices("fallbackEncoding")))],
  ["declined", same(fc.array(anyText, { maxLength: 4 }))],
  ["highlights", same(fc.array(anyText, { maxLength: 4 }))],
  ["nicks", same(fc.array(anyText, { maxLength: 4, minLength: 1 }))],
  ["ircds", same(fc.array(ircd, { maxLength: 3, minLength: 1 }))],
  [
    "channels",
    fc
      .array(anyText, { maxLength: 4 })
      .map((names): readonly [Json, Json] => [names.map((name) => ({ name })), names]),
  ],
  [
    "login",
    fc.constantFrom<readonly [Json, Json]>([{ _tag: "None" }, "None"], [{ _tag: "Sasl" }, "Sasl"]),
  ],
];

describe("the text syntax", () => {
  it.each(values)("reads back what it shows, for %s", (key, arbitrary) => {
    const kind = kindOf(key);

    fc.assert(
      fc.property(arbitrary, ([value, readBack]) => {
        const back = parseText(kind, showText(kind, value));

        expect(back).toStrictEqual({ _tag: "Parsed", value: readBack });
      })
    );
  });

  it("reads back a whole number or a word, for every value the Schema takes, and refuses the rest", () => {
    const kind = uiFields.find((field) => field.key === "width")?.kind ?? { _tag: "Text" };
    const taken = Schema.decodeUnknownOption(UiOptions.fields.width);
    const made = fc.oneof(fc.constant("none"), fc.integer({ max: 450, min: 0 }));

    fc.assert(
      fc.property(
        made.filter((value) => Option.isSome(taken(value))),
        (value) => {
          expect(parseText(kind, showText(kind, value))).toStrictEqual({ _tag: "Parsed", value });
        }
      )
    );

    expect(
      [
        "none",
        " None ",
        "NONE",
        "40",
        " 80 ",
        "400",
        "39",
        "401",
        "80.5",
        "-80",
        "1e2",
        "auto",
        "",
      ].map((text) => parseText(kind, text))
    ).toStrictEqual([
      { _tag: "Parsed", value: "none" },
      { _tag: "Parsed", value: "none" },
      { _tag: "Parsed", value: "none" },
      { _tag: "Parsed", value: 40 },
      { _tag: "Parsed", value: 80 },
      { _tag: "Parsed", value: 400 },
      ...["39", "401", "80.5", "-80", "1e2", "auto", ""].map((text) => ({
        _tag: "Invalid",
        message: `Give a whole number from 40 to 400, or none, not "${text}".`,
      })),
    ]);
  });

  it("reads back every value the Schema takes for a decimal, whatever sum made it, and refuses the rest", () => {
    const kind = uiFields.find((field) => field.key === "leading")?.kind ?? { _tag: "Text" };
    const taken = Schema.decodeUnknownOption(UiOptions.fields.leading);

    // Values made by sums and products, as arithmetic in binary leaves them, as well as
    // those written in hundredths, and whatever the Schema takes of them.
    const made = fc.oneof(
      fc.integer({ max: 200, min: 100 }).map((hundredths) => hundredths / 100),
      fc
        .tuple(fc.integer({ max: 199, min: 100 }), fc.integer({ max: 100, min: 0 }))
        .map(([base, more]) => base / 100 + more / 100),
      fc.double({ max: 2, min: 1, noNaN: true })
    );

    fc.assert(
      fc.property(
        made.filter((value) => Option.isSome(taken(value))),
        (value) => {
          expect(parseText(kind, showText(kind, value))).toStrictEqual({ _tag: "Parsed", value });
        }
      ),
      { numRuns: 500 }
    );

    expect({
      binarySum: Option.isSome(taken(1.1 + 0.05)),
      fine: Option.isSome(taken(1.455)),
      step: Option.isSome(taken(1.15)),
    }).toStrictEqual({ binarySum: false, fine: false, step: true });

    expect(
      [
        "1",
        "2",
        " 1.5 ",
        "1.45",
        "0.99",
        "2.01",
        "1.455",
        "1.",
        ".5",
        "-1.5",
        "1e0",
        "NaN",
        "",
      ].map((text) => parseText(kind, text)._tag)
    ).toStrictEqual([
      "Parsed",
      "Parsed",
      "Parsed",
      "Parsed",
      "Invalid",
      "Invalid",
      "Invalid",
      "Invalid",
      "Invalid",
      "Invalid",
      "Invalid",
      "Invalid",
      "Invalid",
    ]);
  });

  it("shows what it reads, once read, for an Ircd list typed any way", () => {
    const kind = kindOf("ircds");

    const typed = fc
      .array(
        fc.tuple(
          simpleHost,
          fc.option(fc.integer({ max: 65_535, min: 1 })),
          fc.constantFrom("", " plain", " PLAIN")
        ),
        { maxLength: 3, minLength: 1 }
      )
      .map((items) =>
        items
          .map(([name, port, tls]) => `${name}${port === null ? "" : `/${port}`}${tls}`)
          .join(" , ")
      );

    const shownOnce = (text: string) => {
      const once = parseText(kind, text);

      return once._tag === "Parsed" ? showText(kind, once.value) : once.message;
    };

    fc.assert(
      fc.property(typed, (text) => {
        const shown = shownOnce(text);

        expect(shownOnce(shown)).toBe(shown);
      })
    );
  });

  it("takes on, off, true, and false, an Ircd with or without a port and TLS, and refuses the rest", () => {
    const toggle = kindOf("enabled");
    const ircds = kindOf("ircds");

    expect({
      ircds: [
        "irc.test",
        "irc.test/7000",
        "irc.test plain",
        "::1/6697 plain",
        "irc.test/0",
        "a -tlsx",
        "irc.test/6697 -tls",
        "irc.test +tls",
        "",
      ].map((text) => parseText(ircds, text)),
      toggles: ["on", "OFF", "true", "false", "yes"].map((text) => parseText(toggle, text)._tag),
    }).toStrictEqual({
      ircds: [
        { _tag: "Parsed", value: [{ host: "irc.test", port: 6697, tls: true }] },
        { _tag: "Parsed", value: [{ host: "irc.test", port: 7000, tls: true }] },
        { _tag: "Parsed", value: [{ host: "irc.test", port: 6667, tls: false }] },
        { _tag: "Parsed", value: [{ host: "::1", port: 6697, tls: false }] },
        { _tag: "Invalid", message: 'An Ircd\'s port is 1 to 65535, not "0".' },
        { _tag: "Parsed", value: [{ host: "a -tlsx", port: 6697, tls: true }] },
        {
          _tag: "Invalid",
          message:
            'Write host/port for TLS, or host/port plain for plaintext: -tls and +tls are not read, in "irc.test/6697 -tls".',
        },
        {
          _tag: "Invalid",
          message:
            'Write host/port for TLS, or host/port plain for plaintext: -tls and +tls are not read, in "irc.test +tls".',
        },
        { _tag: "Invalid", message: "Give at least one Ircd, as host/port." },
      ],
      toggles: ["Parsed", "Parsed", "Parsed", "Parsed", "Invalid"],
    });
  });
});

describe("a list's syntax", () => {
  it("escapes commas, backslashes, and spaces at an edge, and keeps the rest as given", () => {
    const nicks = kindOf("nicks");
    const shown = (value: readonly string[]) => showText(nicks, value);

    expect({
      edges: shown([" a ", "b"]),
      empty: parseText(nicks, ""),
      escaped: shown(["a,b", "c\\d"]),
      lone: [shown([""]), parseText(nicks, " ")],
      quotes: [shown(['""']), parseText(nicks, '""')],
      read: parseText(nicks, " a\\ , b\\,c ,, d"),
      wrong: parseText(nicks, "a\\b"),
    }).toStrictEqual({
      edges: "\\ a\\ ,b",
      empty: { _tag: "Invalid", message: "Give at least one, comma-separated." },
      escaped: "a\\,b,c\\\\d",
      lone: [" ", { _tag: "Parsed", value: [""] }],
      quotes: ['""', { _tag: "Parsed", value: ['""'] }],
      read: { _tag: "Parsed", value: ["a ", "b,c", "", "d"] },
      wrong: {
        _tag: "Invalid",
        message: "In a list, \\ comes before a comma, a backslash, or a space, and nothing else.",
      },
    });
  });

  it("takes plain text as it is, quotes and spaces included", () => {
    const realname = kindOf("realname");

    expect([
      parseText(realname, '""'),
      parseText(realname, " a "),
      showText(realname, '""'),
    ]).toStrictEqual([{ _tag: "Parsed", value: '""' }, { _tag: "Parsed", value: " a " }, '""']);
  });
});

const join = (channels: readonly string[], chantypes: string | undefined) => {
  const after = apply(
    libera,
    plain,
    { _tag: "Join", channels },
    { casemapping: undefined, chantypes }
  );

  return after._tag === "Parsed"
    ? after.value.channels.slice(1).map((one) => one.name)
    : after.message;
};

const ignore = (text: string): Edit => ({ _tag: "Ignore", mask: IgnoreMask.make(text) });

const unignore = (text: string): Edit => ({ _tag: "Unignore", mask: IgnoreMask.make(text) });

describe("editing", () => {
  it("sets each option to what it shows and gets the same Configuration back", () => {
    const again = optionsOf(libera, full, undefined).flatMap((option) =>
      option.value._tag === "Shown"
        ? [valueOf(set(libera, full, option.path, option.value.text))]
        : []
    );

    expect({
      again: again.every((one) => Schema.is(NetworkConfiguration)(one)),
      same: new Set(again.map((one) => JSON.stringify(one))),
    }).toStrictEqual({
      again: true,
      same: new Set([JSON.stringify(full)]),
    });
  });

  it("sets a value, and refuses one that would not be a Configuration", () => {
    expect({
      empty: set(libera, plain, ["nicks"], ""),
      nicks: valueOf(set(libera, plain, ["nicks"], "a, b ,c")).nicks,
      off: valueOf(set(libera, plain, ["enabled"], "off")).enabled,
      port: valueOf(set(libera, plain, ["ircds"], "127.0.0.1/6670 plain")).ircds,
      wrong: set(libera, plain, ["fallbackEncoding"], "ebcdic")._tag,
    }).toStrictEqual({
      empty: {
        _tag: "Invalid",
        message: "network.libera.nicks: Give at least one, comma-separated.",
      },
      nicks: ["a", "b", "c"],
      off: false,
      port: [{ host: "127.0.0.1", port: 6670, tls: false }],
      wrong: "Invalid",
    });
  });

  it("puts a member in force with its fields as they start, when one of its fields is set", () => {
    expect({
      account: valueOf(set(libera, plain, ["login", "account"], "other")).login,
      none: valueOf(set(libera, full, ["login"], "none")).login,
      same: valueOf(set(libera, full, ["login"], "SASL")).login,
      sasl: valueOf(set(libera, plain, ["login"], "sasl")).login,
    }).toStrictEqual({
      account: {
        _tag: "Sasl",
        account: "other",
        credential: "libera.login.credential",
        required: false,
      },
      none: { _tag: "None" },
      same: full.login,
      sasl: {
        _tag: "Sasl",
        account: "dean",
        credential: "libera.login.credential",
        required: false,
      },
    });
  });

  it("sets up an operator login by its name, starting with the first nick and a named Credential", () => {
    const named = valueOf(set(libera, plain, ["oper", "name"], "admin"));

    expect({
      colon: set(libera, plain, ["oper", "name"], ":admin")._tag,
      login: valueOf(set(libera, plain, ["oper"], "login")).oper,
      named: named.oper,
      none: valueOf(set(libera, named, ["oper"], "none")).oper,
      spaced: set(libera, plain, ["oper", "name"], "two words")._tag,
    }).toStrictEqual({
      colon: "Invalid",
      login: { _tag: "Login", credential: "libera.oper.credential", name: "dean" },
      named: { _tag: "Login", credential: "libera.oper.credential", name: "admin" },
      none: { _tag: "None" },
      spaced: "Invalid",
    });
  });

  it("sets up a service login, keeping a shared field of the member in force", () => {
    const service = valueOf(set(libera, plain, ["login"], "service"));

    expect({
      account: valueOf(set(libera, service, ["login", "account"], "other")).login,
      fromSasl: valueOf(set(libera, full, ["login", "wait"], "10")).login,
      service: service.login,
      tooLong: set(libera, service, ["login", "wait"], "61")._tag,
    }).toStrictEqual({
      account: {
        _tag: "Service",
        account: "other",
        credential: "libera.login.credential",
        service: "NickServ",
        wait: 5,
      },
      fromSasl: {
        _tag: "Service",
        account: "dean",
        credential: "libera.login.credential",
        service: "NickServ",
        wait: 10,
      },
      service: {
        _tag: "Service",
        account: "dean",
        credential: "libera.login.credential",
        service: "NickServ",
        wait: 5,
      },
      tooLong: "Invalid",
    });
  });

  it("keeps a Channel's key when the Channels are set again, and drops a Channel no longer named", () => {
    expect(valueOf(set(libera, full, ["channels"], "#new,#secret")).channels).toStrictEqual([
      { name: "#new" },
      { key: "libera.channels._23secret.key", name: "#secret" },
    ]);
  });

  it("unsets each option to what a new Network starts with, or refuses one that must be given", () => {
    expect({
      channelKey: valueOf(unset(libera, full, ["channels", "#secret", "key"])).channels,
      enabled: valueOf(unset(libera, valueOf(set(libera, plain, ["enabled"], "off")), ["enabled"]))
        .enabled,
      login: valueOf(unset(libera, full, ["login"])).login,
      memberNotInForce: valueOf(unset(libera, plain, ["login", "account"])),
      nicks: unset(libera, plain, ["nicks"]),
      password: "password" in valueOf(unset(libera, full, ["password"])),
      realname: valueOf(unset(libera, plain, ["realname"])).realname,
      required: valueOf(unset(libera, full, ["login", "required"])).login,
      saslCredential: unset(libera, full, ["login", "credential"]),
      saslOff: valueOf(unset(libera, plain, ["login", "credential"])),
    }).toStrictEqual({
      channelKey: [{ name: "#secret" }, { name: "#iirc" }],
      enabled: true,
      login: { _tag: "None" },
      memberNotInForce: plain,
      nicks: {
        _tag: "Invalid",
        message: "network.libera.nicks has no starting value, so it must be given.",
      },
      password: false,
      realname: "dean",
      required: { ...full.login, required: false },
      saslCredential: {
        _tag: "Invalid",
        message:
          "network.libera.login.credential is the Credential login uses, so it cannot be unset. /set network.libera.login none turns login off.",
      },
      saslOff: plain,
    });
  });

  it("points a Credential option at a Credential, and a Channel's key only at a Channel named", () => {
    expect({
      key: valueOf(
        apply(libera, plain, { _tag: "Point", credential: "k", path: ["channels", "#iirc", "key"] })
      ).channels,
      missing: apply(libera, plain, {
        _tag: "Point",
        credential: "k",
        path: ["channels", "#nope", "key"],
      }),
      password: valueOf(
        apply(libera, plain, { _tag: "Point", credential: "p", path: ["password"] })
      ).password,
    }).toStrictEqual({
      key: [{ key: "k", name: "#iirc" }],
      missing: {
        _tag: "Invalid",
        message: "#nope is not among network.libera.channels. Add it there first.",
      },
      password: "p",
    });
  });

  it("joins Channels not already wanted, as the Network folds them, and parts those that are", () => {
    const rfc = { casemapping: "rfc1459", chantypes: "#&" } as const;

    expect({
      joined: valueOf(
        apply(libera, plain, { _tag: "Join", channels: ["#IIRC", "#new", "#new"] }, rfc)
      ).channels,
      missing: apply(libera, plain, { _tag: "Part", channels: ["#nope"] }, rfc),
      parted: valueOf(apply(libera, full, { _tag: "Part", channels: ["#IIRC"] }, rfc)).channels,
      unknownCase: valueOf(apply(libera, plain, { _tag: "Join", channels: ["#IIRC"] })).channels,
    }).toStrictEqual({
      joined: [{ name: "#iirc" }, { name: "#new" }],
      missing: { _tag: "Invalid", message: "#nope is not among the Channels of libera." },
      parted: [{ key: "libera.channels._23secret.key", name: "#secret" }],
      // With no casemapping known, names are compared exactly.
      unknownCase: [{ name: "#iirc" }, { name: "#IIRC" }],
    });
  });

  it("ignores a mask once, and unignores it compared as the Network folds it", () => {
    const ascii = { casemapping: "ascii", chantypes: "#" } as const;
    const rfc = { casemapping: "rfc1459", chantypes: "#" } as const;
    const held = valueOf(set(libera, plain, ["ignores"], "p[a]!*@*,*!*@spam.example"));

    expect({
      added: valueOf(apply(libera, plain, ignore("peer!*@*"), rfc)).ignores,
      again: valueOf(apply(libera, held, ignore("P{A}!*@*"), rfc)).ignores,
      apart: valueOf(apply(libera, held, ignore("P{A}!*@*"), ascii)).ignores,
      folded: valueOf(apply(libera, held, unignore("P{A}!*@*"), rfc)).ignores,
      missing: apply(libera, held, unignore("nobody!*@*"), rfc),
      notFolded: apply(libera, held, unignore("p{a}!*@*"), ascii),
      // Until a Network declares a mapping, masks fold by rfc1459, as the Client folds them.
      unknown: valueOf(apply(libera, held, unignore("P{A}!*@*"))).ignores,
    }).toStrictEqual({
      added: ["peer!*@*"],
      again: ["p[a]!*@*", "*!*@spam.example"],
      apart: ["p[a]!*@*", "*!*@spam.example", "P{A}!*@*"],
      folded: ["*!*@spam.example"],
      missing: {
        _tag: "Invalid",
        message: "nobody!*@* is not among network.libera.ignores.",
      },
      notFolded: {
        _tag: "Invalid",
        message: "p{a}!*@* is not among network.libera.ignores.",
      },
      unknown: ["*!*@spam.example"],
    });
  });

  it("never merges or parts two Channels an ascii Network tells apart", () => {
    const ascii = { casemapping: "ascii", chantypes: "#" } as const;
    const rfc = { casemapping: "rfc1459", chantypes: "#" } as const;
    const square = valueOf(set(libera, plain, ["channels"], "#[a]"));
    const both = valueOf(set(libera, plain, ["channels"], "#[a],#{a}"));

    expect({
      folded: apply(libera, both, { _tag: "Part", channels: ["#[A]"] }, rfc),
      joined: valueOf(apply(libera, square, { _tag: "Join", channels: ["#{a}"] }, ascii)).channels,
      parted: valueOf(apply(libera, both, { _tag: "Part", channels: ["#[a]"] }, ascii)).channels,
      partedExact: valueOf(apply(libera, both, { _tag: "Part", channels: ["#{a}"] }, rfc)).channels,
      timeline: valueOf(
        apply(libera, both, { _tag: "PartTimeline", key: "#{a}", name: "#{a}" }, ascii)
      ).channels,
      timelineFolded: apply(libera, both, { _tag: "PartTimeline", key: "#{a}", name: "#[A]" }, rfc),
      timelineUnknown: valueOf(
        apply(libera, square, { _tag: "PartTimeline", key: "#{a}", name: "#[a]" })
      ).channels,
    }).toStrictEqual({
      folded: {
        _tag: "Invalid",
        message: "#[A] could be any of #[a], #{a} on libera. Part one by its exact name.",
      },
      joined: [{ name: "#[a]" }, { name: "#{a}" }],
      parted: [{ name: "#{a}" }],
      partedExact: [{ name: "#[a]" }],
      timeline: [{ name: "#[a]" }],
      timelineFolded: {
        _tag: "Invalid",
        message: "#[A] could be any of #[a], #{a} on libera. Part one by its exact name.",
      },
      // Keys are folded by rfc1459 until a Network declares a mapping, as the Daemon folds them.
      timelineUnknown: [],
    });
  });

  it("keeps a name with a CHANTYPES prefix as given, prefixes a bare one, and never guesses", () => {
    expect({
      ampersand: join(["&local", "bare"], "&"),
      percent: join(["%help", "help"], "%"),
      rfc: join(["#a", "&b", "+c", "!d"], undefined),
      unknown: join(["%help"], undefined),
    }).toStrictEqual({
      ampersand: ["&local", "&bare"],
      percent: ["%help"],
      rfc: ["#a", "&b", "+c", "!d"],
      unknown:
        "libera has not said what its Channels start with, so give %help with its prefix, such as #%help.",
    });
  });

  // Any option of a valid Configuration, set to any text, gives a valid Configuration or says why.
  it("always gives a Configuration, or why not", () => {
    const options = optionsOf(libera, full, undefined);
    const valid = Schema.is(NetworkConfiguration);

    fc.assert(
      fc.property(fc.constantFrom(...options), fc.string(), (option: NetworkOption, text) => {
        const after = set(libera, full, option.path, text);

        expect(after._tag === "Invalid" || valid(after.value)).toBeTruthy();
      })
    );
  });
});

const setTo = (line: string) => {
  const parsed = read(line);
  const [intent] = parsed._tag === "Parsed" ? parsed.value : [];

  return intent?._tag === "Configure" && intent.edit._tag === "Set" ? intent.edit.text : parsed;
};

const configure = (edit: Edit): readonly Intent[] => [{ _tag: "Configure", edit, network: libera }];

const configureMask = (_tag: "Ignore" | "Unignore", text: string) => ({
  _tag: "Parsed",
  value: configure({ _tag, mask: IgnoreMask.make(text) }),
});

const neither = (text: string) => ({
  _tag: "Invalid",
  message: `${text} is neither a nick nor a mask of nick!user@host, with each part given, at most 255 characters, and no space or comma.`,
});

describe("the commands", () => {
  it("open the options view with /set alone or a pattern, and set or unset an option", () => {
    expect({
      alone: read("/set"),
      pattern: read("/set *nick*"),
      set: read("/set network.libera.nicks a,b"),
      unknown: read("/set network.libera.nope x"),
      unset: read("/unset network.libera.realname"),
      wrong: read("/set network.libera.enabled maybe"),
    }).toStrictEqual({
      alone: { _tag: "Parsed", value: [{ _tag: "OpenOptions", filter: "" }] },
      pattern: { _tag: "Parsed", value: [{ _tag: "OpenOptions", filter: "*nick*" }] },
      set: {
        _tag: "Parsed",
        value: [
          {
            _tag: "Configure",
            edit: { _tag: "Set", path: ["nicks"], text: "a,b" },
            network: libera,
          },
        ],
      },
      unknown: { _tag: "Invalid", message: "There is no option network.libera.nope." },
      unset: {
        _tag: "Parsed",
        value: [
          { _tag: "Configure", edit: { _tag: "Unset", path: ["realname"] }, network: libera },
        ],
      },
      wrong: { _tag: "Invalid", message: 'network.libera.enabled: Say on or off, not "maybe".' },
    });
  });

  it("set text as the rest of the line, verbatim, an empty one included", () => {
    expect([
      setTo('/set network.libera.realname  "two"  spaces '),
      setTo("/set network.libera.realname "),
      setTo("/set network.libera.declined "),
    ]).toStrictEqual([' "two"  spaces ', "", ""]);
  });

  it("ask for a Credential option's value in a prompt, and refuse one typed after it", () => {
    expect({
      prompt: read("/set network.libera.login.credential"),
      typed: read("/set network.libera.login.credential hunter2 two"),
    }).toStrictEqual({
      prompt: {
        _tag: "Parsed",
        value: [{ _tag: "PromptCredential", network: libera, path: ["login", "credential"] }],
      },
      typed: {
        _tag: "Invalid",
        message:
          "A Credential's value is never typed into the composer. It was cleared, and nothing was sent. Use /set network.libera.login.credential alone, which asks for it in a password prompt.",
      },
    });
  });

  it("add a Network with one Ircd and one nick, everything else as a new Network starts", () => {
    const added = read("/network add test 127.0.0.1/6670 plain bot");

    expect({
      added,
      badId: read("/network add Test irc.test bot"),
      noNick: read("/network add test irc.test"),
      oldFlag: read("/network add test 127.0.0.1/6670 -tls bot"),
      verb: read("/network rename test"),
    }).toStrictEqual({
      added: {
        _tag: "Parsed",
        value: [
          {
            _tag: "AddNetwork",
            configuration: decode({
              answerCtcp: true,
              channels: [],
              declined: [],
              enabled: true,
              fallbackEncoding: "windows-1252",
              ircds: [{ host: "127.0.0.1", port: 6670, tls: false }],
              login: { _tag: "None" },
              nicks: ["bot"],
              realname: "bot",
              username: "bot",
            }),
            network: Schema.decodeSync(NetworkId)("test"),
          },
        ],
      },
      badId: {
        _tag: "Invalid",
        message:
          'A Network\'s id is 1 to 64 lower-case letters, digits, ., _, or -, not "Test". /network add <id> <host>[/port] [plain] <nick>',
      },
      noNick: {
        _tag: "Invalid",
        message: "Give an Ircd and a nick. /network add <id> <host>[/port] [plain] <nick>",
      },
      oldFlag: {
        _tag: "Invalid",
        message:
          'Write host/port for TLS, or host/port plain for plaintext: -tls and +tls are not read, in "127.0.0.1/6670 -tls".',
      },
      verb: {
        _tag: "Invalid",
        message:
          "Use /network add <id> <host>[/port] [plain] <nick>, or /network remove [id] [keep|drop].",
      },
    });
  });

  it("start a new Network as its Schema says, with what must be given, given", () => {
    expect({
      missing: starting(libera, { nicks: ["x"] }),
      started: starting(libera, { ircds: [{ host: "h", port: 1, tls: true }], nicks: ["x"] }),
    }).toStrictEqual({
      missing: {
        _tag: "Invalid",
        message: "network.libera.ircds has no starting value, so it must be given.",
      },
      started: {
        _tag: "Parsed",
        value: decode({
          answerCtcp: true,
          channels: [],
          declined: [],
          enabled: true,
          fallbackEncoding: "windows-1252",
          ircds: [{ host: "h", port: 1, tls: true }],
          login: { _tag: "None" },
          nicks: ["x"],
          realname: "x",
          username: "x",
        }),
      },
    });
  });

  it("join and part on the focused Network, the open Channel when /part names none", () => {
    expect({
      join: read("/join #a,b", inChannel),
      keyed: read("/join #a key", inChannel)._tag,
      nowhere: read("/join #a"),
      part: read("/part", inChannel),
      partNamed: read("/part #b", inChannel),
    }).toStrictEqual({
      // A bare name is prefixed only once the Daemon says what CHANTYPES is.
      join: { _tag: "Parsed", value: configure({ _tag: "Join", channels: ["#a", "b"] }) },
      keyed: "Invalid",
      nowhere: { _tag: "Invalid", message: "Open a Timeline first." },
      part: {
        _tag: "Parsed",
        value: configure({ _tag: "PartTimeline", key: "#iirc", name: "#iirc" }),
      },
      partNamed: { _tag: "Parsed", value: configure({ _tag: "Part", channels: ["#b"] }) },
    });
  });

  it("ignore a nick as nick!*@*, or a mask, refuse what is neither, and list the ignores", () => {
    expect({
      bad: read("/ignore peer!x", inChannel),
      comma: read("/ignore a,b", inChannel),
      list: read("/ignore", inChannel),
      mask: read("/ignore *!*@spam.example", inChannel),
      nick: read("/ignore Peer", inChannel),
      nowhere: read("/ignore peer"),
      two: read("/ignore a b", inChannel),
      unignore: read("/unignore Peer", inChannel),
      unignoreBad: read("/unignore @host", inChannel),
      unignoreMask: read("/unignore *!*@spam.example", inChannel),
    }).toStrictEqual({
      bad: neither("peer!x"),
      comma: neither("a,b"),
      list: { _tag: "Parsed", value: [{ _tag: "OpenOptions", filter: "network.libera.ignores" }] },
      mask: configureMask("Ignore", "*!*@spam.example"),
      nick: configureMask("Ignore", "Peer!*@*"),
      nowhere: { _tag: "Invalid", message: "Open a Timeline first." },
      two: { _tag: "Invalid", message: "Give one nick or mask. /ignore [<nick|mask>]" },
      unignore: configureMask("Unignore", "Peer!*@*"),
      unignoreBad: neither("@host"),
      unignoreMask: configureMask("Unignore", "*!*@spam.example"),
    });
  });

  it("clear a Credential's value typed into the composer at once, keeping it nowhere", () => {
    const typed = reduceComposers(
      reduceComposers(initialComposers, {
        _tag: "Edited",
        text: "/me before",
        timeline: "Nowhere",
      }),
      {
        _tag: "Edited",
        text: "/set network.libera.password hunter2\n/set network.libera.enabled on",
        timeline: "Nowhere",
      }
    );

    const refused = submit(typed, "Nowhere", nowhere);
    const draft = draftOf(refused.state, "Nowhere");

    expect({
      held: JSON.stringify([...refused.state.drafts]).includes("hunter2"),
      intents: refused.intents,
      notice: draft.notice?.message.startsWith("A Credential's value is never typed"),
      text: [draft.text, draft.kept, draft.history],
    }).toStrictEqual({
      held: false,
      intents: [],
      notice: true,
      text: ["", "", []],
    });
  });
});

describe("the options view", () => {
  it("lists the options of each Network read, filtered, and keeps the newest read", () => {
    const opened: readonly OptionsEvent[] = [
      { _tag: "Listed", networks: [libera, dotted] },
      { _tag: "Read", configuration: plain, network: libera, sequence: 5 },
      { _tag: "Read", configuration: full, network: dotted, sequence: 2 },
      { _tag: "Read", configuration: full, network: libera, sequence: 3 },
    ];

    let state = initialOptions;

    for (const event of opened) {
      state = reduceOptions(state, event);
    }

    expect({
      kept: state.networks.get(libera),
      names: listed(state, "*nicks").map((option) => option.name),
    }).toStrictEqual({
      kept: { _tag: "Read", configuration: plain, sequence: 5 },
      names: ["network.libera.nicks", "network.my.net.nicks"],
    });
  });
});

const change = (option: string, value: Json | undefined, device: boolean) => ({
  _tag: "Parsed",
  value: [{ _tag: "ChangeUi", device, option, value }],
});

/**
 * What the options view lists of ui.font: the value in effect, and what it says of it.
 * @param args - What `uiOptionsOf` takes.
 * @returns The row's values.
 */
const fontRow = (...args: Parameters<typeof uiOptionsOf>) =>
  uiOptionsOf(...args)
    .filter((one) => one.option === "font")
    .map((one) => [one.value, one.note]);

const fontRefused = (text: string) => `ui.font cannot be "${text}".`;

const leadingRefused = (text: string) =>
  `ui.leading: Give a number from 1 to 2, in steps of 0.01, not "${text}".`;

const suffixRefused = (why: string) => `ui.suffix must ${why}.`;

const widthRefused = (text: string) =>
  `ui.width: Give a whole number from 40 to 400, or none, not "${text}".`;

const defaultPlayers =
  "www.youtube-nocookie.com,player.vimeo.com,w.soundcloud.com,bandcamp.com,open.spotify.com,player.twitch.tv";

describe("the options under ui", () => {
  const shared = {
    options: {
      activity: "quiet",
      colours: "theme",
      dark: "dark",
      day: "full",
      enter: "send",
      font: "system",
      leading: 1.45,
      light: "light",
      previews: "off",
      "previews.animate": false,
      "previews.folded": "summary",
      "previews.mediaHeight": "medium",
      "previews.players": ["player.vimeo.com", "w.soundcloud.com"],
      "previews.style": "thumbnail",
      "previews.timelines": {},
      read: "latest",
      size: 14,
      spellcheck: false,
      suffix: ", ",
      theme: "dark",
      themes: [],
      time: "HH:mm",
      width: "none",
    },
    sequence: 7,
  } as const;

  it("has an option for every field of the contract's UiOptions, each described, with its kind", () => {
    expect({
      described: uiFields.every((field) => field.description !== ""),
      keys: uiFields.map((field) => field.key),
      kinds: uiFields.map((field) => field.kind),
    }).toStrictEqual({
      described: true,
      keys: Object.keys(UiOptions.fields),
      kinds: [
        { _tag: "Choice", choices: ["all", "quiet", "none"] },
        { _tag: "Choice", choices: ["theme", "raw"] },
        { _tag: "Text" },
        { _tag: "Choice", choices: ["full", "long", "medium", "short", "iso"] },
        { _tag: "Choice", choices: ["send", "newline"] },
        {
          _tag: "ChoiceOrText",
          choices: [
            "system",
            "jetbrains-mono",
            "ibm-plex-mono",
            "source-code-pro",
            "commit-mono",
            "atkinson-hyperlegible-mono",
            "system-sans",
            "ibm-plex-sans",
            "atkinson-hyperlegible-next",
            "source-sans-3",
            "inter",
          ],
        },
        { _tag: "Decimal", maximum: 2, minimum: 1, step: 0.01 },
        { _tag: "Text" },
        { _tag: "Choice", choices: ["off", "links only", "on"] },
        { _tag: "Toggle" },
        { _tag: "Choice", choices: ["open", "summary", "chip"] },
        { _tag: "Choice", choices: ["small", "medium", "large"] },
        { _tag: "Texts", nonEmpty: false },
        { _tag: "Choice", choices: ["line", "thumbnail", "card"] },
        { _tag: "ChoiceByKey", choices: ["off", "links only", "on"] },
        { _tag: "Choice", choices: ["shown", "latest", "asked"] },
        { _tag: "Integer", maximum: 24, minimum: 10 },
        { _tag: "Toggle" },
        { _tag: "Text" },
        { _tag: "Text" },
        { _tag: "Names", fields: [] },
        { _tag: "Choice", choices: ["HH:mm", "HH:mm:ss", "h:mm a", "h:mm:ss a", "none"] },
        { _tag: "IntegerOrChoice", choices: ["none"], maximum: 400, minimum: 40 },
      ],
    });
  });

  it("lists each with the value in effect, the shared one, and this device's override", () => {
    const options = uiOptionsOf(shared, { size: 18, theme: "light" });
    const before = uiOptionsOf(undefined, {});

    expect({
      before: before.map((one) => [one.name, one.value, one.shared, one.device]),
      options: options.map((one) => [one.name, one.value, one.shared, one.device, one.starts]),
    }).toStrictEqual({
      before: [
        ["ui.activity", { _tag: "Shown", text: "all" }, { _tag: "Unset" }, undefined],
        ["ui.colours", { _tag: "Shown", text: "theme" }, { _tag: "Unset" }, undefined],
        ["ui.dark", { _tag: "Shown", text: "dark" }, { _tag: "Unset" }, undefined],
        ["ui.day", { _tag: "Shown", text: "full" }, { _tag: "Unset" }, undefined],
        ["ui.enter", { _tag: "Shown", text: "send" }, { _tag: "Unset" }, undefined],
        ["ui.font", { _tag: "Shown", text: "system" }, { _tag: "Unset" }, undefined],
        ["ui.leading", { _tag: "Shown", text: "1.45" }, { _tag: "Unset" }, undefined],
        ["ui.light", { _tag: "Shown", text: "light" }, { _tag: "Unset" }, undefined],
        ["ui.previews", { _tag: "Shown", text: "off" }, { _tag: "Unset" }, undefined],
        ["ui.previews.animate", { _tag: "Shown", text: "off" }, { _tag: "Unset" }, undefined],
        ["ui.previews.folded", { _tag: "Shown", text: "summary" }, { _tag: "Unset" }, undefined],
        [
          "ui.previews.mediaHeight",
          { _tag: "Shown", text: "medium" },
          { _tag: "Unset" },
          undefined,
        ],
        [
          "ui.previews.players",
          { _tag: "Shown", text: defaultPlayers },
          { _tag: "Unset" },
          undefined,
        ],
        ["ui.previews.style", { _tag: "Shown", text: "thumbnail" }, { _tag: "Unset" }, undefined],
        ["ui.previews.timelines", { _tag: "Shown", text: "" }, { _tag: "Unset" }, undefined],
        ["ui.read", { _tag: "Shown", text: "latest" }, { _tag: "Unset" }, undefined],
        ["ui.size", { _tag: "Shown", text: "14" }, { _tag: "Unset" }, undefined],
        ["ui.spellcheck", { _tag: "Shown", text: "on" }, { _tag: "Unset" }, undefined],
        ["ui.suffix", { _tag: "Shown", text: ": " }, { _tag: "Unset" }, undefined],
        ["ui.theme", { _tag: "Shown", text: "system" }, { _tag: "Unset" }, undefined],
        ["ui.themes", { _tag: "Shown", text: "" }, { _tag: "Unset" }, undefined],
        ["ui.time", { _tag: "Shown", text: "HH:mm" }, { _tag: "Unset" }, undefined],
        ["ui.width", { _tag: "Shown", text: "none" }, { _tag: "Unset" }, undefined],
      ],
      options: [
        [
          "ui.activity",
          { _tag: "Shown", text: "quiet" },
          { _tag: "Shown", text: "quiet" },
          undefined,
          "all",
        ],
        [
          "ui.colours",
          { _tag: "Shown", text: "theme" },
          { _tag: "Shown", text: "theme" },
          undefined,
          "theme",
        ],
        [
          "ui.dark",
          { _tag: "Shown", text: "dark" },
          { _tag: "Shown", text: "dark" },
          undefined,
          "dark",
        ],
        [
          "ui.day",
          { _tag: "Shown", text: "full" },
          { _tag: "Shown", text: "full" },
          undefined,
          "full",
        ],
        [
          "ui.enter",
          { _tag: "Shown", text: "send" },
          { _tag: "Shown", text: "send" },
          undefined,
          "send",
        ],
        [
          "ui.font",
          { _tag: "Shown", text: "system" },
          { _tag: "Shown", text: "system" },
          undefined,
          "system",
        ],
        [
          "ui.leading",
          { _tag: "Shown", text: "1.45" },
          { _tag: "Shown", text: "1.45" },
          undefined,
          "1.45",
        ],
        [
          "ui.light",
          { _tag: "Shown", text: "light" },
          { _tag: "Shown", text: "light" },
          undefined,
          "light",
        ],
        [
          "ui.previews",
          { _tag: "Shown", text: "off" },
          { _tag: "Shown", text: "off" },
          undefined,
          "off",
        ],
        [
          "ui.previews.animate",
          { _tag: "Shown", text: "off" },
          { _tag: "Shown", text: "off" },
          undefined,
          "off",
        ],
        [
          "ui.previews.folded",
          { _tag: "Shown", text: "summary" },
          { _tag: "Shown", text: "summary" },
          undefined,
          "summary",
        ],
        [
          "ui.previews.mediaHeight",
          { _tag: "Shown", text: "medium" },
          { _tag: "Shown", text: "medium" },
          undefined,
          "medium",
        ],
        [
          "ui.previews.players",
          { _tag: "Shown", text: "player.vimeo.com,w.soundcloud.com" },
          { _tag: "Shown", text: "player.vimeo.com,w.soundcloud.com" },
          undefined,
          defaultPlayers,
        ],
        [
          "ui.previews.style",
          { _tag: "Shown", text: "thumbnail" },
          { _tag: "Shown", text: "thumbnail" },
          undefined,
          "thumbnail",
        ],
        [
          "ui.previews.timelines",
          { _tag: "Shown", text: "" },
          { _tag: "Shown", text: "" },
          undefined,
          "",
        ],
        [
          "ui.read",
          { _tag: "Shown", text: "latest" },
          { _tag: "Shown", text: "latest" },
          undefined,
          "latest",
        ],
        [
          "ui.size",
          { _tag: "Shown", text: "18" },
          { _tag: "Shown", text: "14" },
          { _tag: "Shown", text: "18" },
          "14",
        ],
        [
          "ui.spellcheck",
          { _tag: "Shown", text: "off" },
          { _tag: "Shown", text: "off" },
          undefined,
          "on",
        ],
        [
          "ui.suffix",
          { _tag: "Shown", text: ", " },
          { _tag: "Shown", text: ", " },
          undefined,
          ": ",
        ],
        [
          "ui.theme",
          { _tag: "Shown", text: "light" },
          { _tag: "Shown", text: "dark" },
          { _tag: "Shown", text: "light" },
          "system",
        ],
        ["ui.themes", { _tag: "Shown", text: "" }, { _tag: "Shown", text: "" }, undefined, ""],
        [
          "ui.time",
          { _tag: "Shown", text: "HH:mm" },
          { _tag: "Shown", text: "HH:mm" },
          undefined,
          "HH:mm",
        ],
        [
          "ui.width",
          { _tag: "Shown", text: "none" },
          { _tag: "Shown", text: "none" },
          undefined,
          "none",
        ],
      ],
    });
  });

  it("forgets the shared ones once the page signs out, so an older read after is taken", () => {
    const newer = { ...shared, sequence: 9 };

    const forgotten = reduceOptions(reduceOptions(initialOptions, { _tag: "UiRead", ui: newer }), {
      _tag: "UiForgotten",
    });

    expect({
      after: reduceOptions(forgotten, { _tag: "UiRead", ui: shared }).ui,
      forgotten: forgotten.ui,
    }).toStrictEqual({ after: shared, forgotten: undefined });
  });

  it("lists them after every Network's, filtered, and keeps the newest read of them", () => {
    let state = initialOptions;

    for (const event of [
      { _tag: "Listed", networks: [libera] },
      { _tag: "Read", configuration: plain, network: libera, sequence: 5 },
      { _tag: "UiRead", ui: shared },
      {
        _tag: "UiRead",
        ui: { ...shared, options: { ...shared.options, time: "none" }, sequence: 3 },
      },
    ] satisfies readonly OptionsEvent[]) {
      state = reduceOptions(state, event);
    }

    expect({
      kept: state.ui,
      last: listed(state, "")
        .map((option) => option.name)
        .slice(-23),
      time: listed(state, "*time", { time: "HH:mm:ss" }).map((option) => option.value),
    }).toStrictEqual({
      kept: shared,
      last: [
        "ui.activity",
        "ui.colours",
        "ui.dark",
        "ui.day",
        "ui.enter",
        "ui.font",
        "ui.leading",
        "ui.light",
        "ui.previews",
        "ui.previews.animate",
        "ui.previews.folded",
        "ui.previews.mediaHeight",
        "ui.previews.players",
        "ui.previews.style",
        "ui.previews.timelines",
        "ui.read",
        "ui.size",
        "ui.spellcheck",
        "ui.suffix",
        "ui.theme",
        "ui.themes",
        "ui.time",
        "ui.width",
      ],
      time: [{ _tag: "Shown", text: "HH:mm:ss" }],
    });
  });

  it("say a font's family in effect that this device lacks was not found on it", () => {
    const family = Schema.decodeUnknownSync(FontFamily);
    const fira = family("Fira Code");
    const iosevka = family("Iosevka Term");
    const sharing = { ...shared, options: { ...shared.options, font: fira } };

    expect({
      deviceFound: fontRow(sharing, { font: iosevka }, new Set([fira])),
      deviceLacks: fontRow(sharing, { font: iosevka }, new Set([iosevka])),
      neither: fontRow(sharing, { font: iosevka }, new Set()),
      sharedLacked: fontRow(sharing, {}, new Set([fira])),
      // Only a family is ever lacked: a theme of the same name is no font.
      theme: uiOptionsOf(shared, {}, new Set([family("dark")]))
        .filter((one) => one.option === "theme")
        .map((one) => one.note),
    }).toStrictEqual({
      // Every device's family is lacked, but this device draws its own.
      deviceFound: [[{ _tag: "Shown", text: "Iosevka Term" }, undefined]],
      deviceLacks: [[{ _tag: "Shown", text: "Iosevka Term" }, fontMissing]],
      neither: [[{ _tag: "Shown", text: "Iosevka Term" }, undefined]],
      sharedLacked: [[{ _tag: "Shown", text: "Fira Code" }, fontMissing]],
      theme: [undefined],
    });
    expect(fontMissing).toBe("not found on this device");
  });

  it("offer ui.previews as off, links only, or on, off to start, set by /set for every device and never for one", () => {
    const previews = uiOptionsOf(shared, { previews: "on" }).find(
      (one) => one.option === "previews"
    );

    expect({
      device: read("/set -device ui.previews on"),
      kind: previews?.kind,
      links: read("/set ui.previews links only"),
      linksCase: read("/set ui.previews  Links Only "),
      linksWord: read("/set ui.previews links"),
      shown: [previews?.value, previews?.device, previews?.starts],
      unset: read("/unset ui.previews"),
      unsetDevice: read("/unset -device ui.previews"),
    }).toStrictEqual({
      device: {
        _tag: "Invalid",
        message:
          "ui.previews is shared by every device, so no device overrides it. Use /set ui.previews without -device.",
      },
      kind: { _tag: "Choice", choices: ["off", "links only", "on"] },
      links: {
        _tag: "Parsed",
        value: [{ _tag: "ChangeUi", device: false, option: "previews", value: "links only" }],
      },
      linksCase: {
        _tag: "Parsed",
        value: [{ _tag: "ChangeUi", device: false, option: "previews", value: "links only" }],
      },
      linksWord: {
        _tag: "Invalid",
        message: 'ui.previews: Choose one of off, links only, on, not "links".',
      },
      // A device's override of it, kept by hand, is neither shown nor in effect.
      shown: [{ _tag: "Shown", text: "off" }, undefined, "off"],
      unset: {
        _tag: "Parsed",
        value: [{ _tag: "ChangeUi", device: false, option: "previews", value: undefined }],
      },
      unsetDevice: {
        _tag: "Invalid",
        message:
          "ui.previews is shared by every device, so no device overrides it. Use /set ui.previews without -device.",
      },
    });
  });

  it("offer ui.previews.players as a list of hosts, shared by every device, and read back the same", () => {
    const option = uiOptionsOf(shared, {}).find((found) => found.option === "previews.players");
    const typed = read("/set ui.previews.players player.vimeo.com, w.soundcloud.com");

    expect({
      device: read("/set -device ui.previews.players player.vimeo.com"),
      kind: option?.kind,
      notAHost: read("/set ui.previews.players Vimeo")._tag,
      shown: [option?.value, option?.device, option?.starts],
      typed,
    }).toStrictEqual({
      device: {
        _tag: "Invalid",
        message:
          "ui.previews.players is shared by every device, so no device overrides it. Use /set ui.previews.players without -device.",
      },
      kind: { _tag: "Texts", nonEmpty: false },
      notAHost: "Invalid",
      shown: [
        { _tag: "Shown", text: "player.vimeo.com,w.soundcloud.com" },
        undefined,
        defaultPlayers,
      ],
      typed: {
        _tag: "Parsed",
        value: [
          {
            _tag: "ChangeUi",
            device: false,
            option: "previews.players",
            value: ["player.vimeo.com", "w.soundcloud.com"],
          },
        ],
      },
    });
  });

  it("offer ui.previews.timelines as each Timeline's choice, typed id=mode and read back the same", () => {
    const one = "00000000000002-00000000-00000000";
    const two = "00000000000003-00000000-00000000";
    const kind: Kind = { _tag: "ChoiceByKey", choices: ["off", "links only", "on"] };
    const typed = parseText(kind, ` ${one}=LINKS, ${two} = on `);
    const option = uiOptionsOf(shared, {}).find((found) => found.option === "previews.timelines");

    expect({
      kind: option?.kind,
      named: read(`/set ui.previews.timelines ${one}=links only`),
      notAnId: read("/set ui.previews.timelines libera=on"),
      shown: [option?.value, option?.starts],
      twice: parseText(kind, `${one}=on,${one}=off`),
      typed,
      typedBack: typed._tag === "Parsed" ? parseText(kind, showText(kind, typed.value)) : undefined,
      unknownMode: parseText(kind, `${one}=sometimes`),
      without: parseText(kind, one),
    }).toStrictEqual({
      kind,
      named: {
        _tag: "Parsed",
        value: [
          {
            _tag: "ChangeUi",
            device: false,
            option: "previews.timelines",
            value: { [one]: "links only" },
          },
        ],
      },
      notAnId: { _tag: "Invalid", message: 'ui.previews.timelines cannot be "libera=on".' },
      shown: [{ _tag: "Shown", text: "" }, ""],
      twice: { _tag: "Invalid", message: `${one} is given more than once.` },
      typed: { _tag: "Parsed", value: { [one]: "links only", [two]: "on" } },
      typedBack: { _tag: "Parsed", value: { [one]: "links only", [two]: "on" } },
      unknownMode: {
        _tag: "Invalid",
        message: 'Choose one of off, links only, on, not "sometimes".',
      },
      without: {
        _tag: "Invalid",
        message: `Give each as key=choice, not "${one}".`,
      },
    });
    expect(showText(kind, { [one]: "links only", [two]: "on" })).toBe(
      `${one}=links only,${two}=on`
    );
  });

  it("are set and unset with /set and /unset, for every device or with -device for this one", () => {
    expect({
      alone: read("/set ui.time"),
      anyCase: read("/set ui.time hh:mm:ss"),
      device: read("/set -device ui.theme light"),
      deviceAlone: read("/set -device"),
      deviceNetwork: read("/set -device network.libera.nicks a"),
      empty: read("/set ui.time "),
      enter: read("/set ui.enter newline"),
      enterDevice: read("/set -device ui.enter NewLine"),
      enterWrong: read("/set ui.enter shift"),
      font: read("/set ui.font IBM-Plex-Mono"),
      fontFamily: read("/set ui.font  Fira Code "),
      fontFamilyDevice: read("/set -device ui.font Fira Code"),
      fontFamilyEscaped: read(String.raw`/set -device ui.font Fira\ Code`),
      fontFamilyQuoted: read('/set ui.font Fira" Code'),
      fontFamilyTooLong: read(`/set ui.font ${"x".repeat(65)}`),
      fontSans: read("/set ui.font Inter"),
      fontSystemSans: read("/set ui.font system-sans"),
      fractional: read("/set ui.size 14.5"),
      leading: read("/set ui.leading 1.6"),
      leadingDevice: read("/set -device ui.leading 1.2"),
      leadingNotANumber: read("/set ui.leading abc"),
      leadingTooBig: read("/set ui.leading 2.5"),
      leadingTooFine: read("/set ui.leading 1.555"),
      leadingTooSmall: read("/set ui.leading 0.9"),
      shared: read("/set ui.time HH:mm:ss"),
      size: read("/set -device ui.size 20"),
      spellcheck: read("/set ui.spellcheck off"),
      spellcheckDevice: read("/set -device ui.spellcheck ON"),
      spellcheckWrong: read("/set ui.spellcheck maybe"),
      suffix: read("/set ui.suffix , "),
      suffixAlone: read("/set -device ui.suffix"),
      suffixControl: read("/set ui.suffix :\u0003 "),
      suffixDevice: read("/set -device ui.suffix  -> "),
      suffixLongest: read(`/set ui.suffix ${"x".repeat(8)}`),
      suffixNone: read("/set ui.suffix "),
      suffixSpace: read("/set ui.suffix  "),
      suffixTooLong: read(`/set ui.suffix ${"x".repeat(9)}`),
      tooBig: read("/set ui.size 25"),
      tooSmall: read("/set ui.size 9"),
      twelveHour: read("/set ui.time h:mm:ss a"),
      twelveHourAnyCase: read("/set ui.time H:MM A"),
      unknown: read("/set ui.palette dusk"),
      unset: read("/unset ui.activity"),
      unsetDevice: read("/unset -device ui.theme"),
      width: read("/set ui.width 80"),
      widthDevice: read("/set -device ui.width 120"),
      widthFractional: read("/set ui.width 80.5"),
      widthNone: read("/set ui.width NONE"),
      widthTooBig: read("/set ui.width 401"),
      widthTooSmall: read("/set ui.width 39"),
      widthWord: read("/set ui.width auto"),
      wrong: read("/set ui.activity loud"),
      wrongTime: read("/set ui.time noon"),
    }).toStrictEqual({
      alone: { _tag: "Parsed", value: [{ _tag: "OpenOptions", filter: "ui.time" }] },
      anyCase: change("time", "HH:mm:ss", false),
      device: change("theme", "light", true),
      deviceAlone: {
        _tag: "Invalid",
        message:
          "Only an option under ui is kept for this device, as in /set -device ui.theme light.",
      },
      deviceNetwork: {
        _tag: "Invalid",
        message:
          "Only an option under ui is kept for this device, as in /set -device ui.theme light.",
      },
      empty: { _tag: "Invalid", message: "Give ui.time a value, or use /unset ui.time." },
      enter: change("enter", "newline", false),
      enterDevice: change("enter", "newline", true),
      enterWrong: {
        _tag: "Invalid",
        message: 'ui.enter: Choose one of send, newline, not "shift".',
      },
      font: change("font", "ibm-plex-mono", false),
      fontFamily: change("font", "Fira Code", false),
      fontFamilyDevice: change("font", "Fira Code", true),
      fontFamilyEscaped: { _tag: "Invalid", message: fontRefused(String.raw`Fira\ Code`) },
      fontFamilyQuoted: { _tag: "Invalid", message: fontRefused('Fira" Code') },
      fontFamilyTooLong: { _tag: "Invalid", message: fontRefused("x".repeat(65)) },
      fontSans: change("font", "inter", false),
      fontSystemSans: change("font", "system-sans", false),
      fractional: {
        _tag: "Invalid",
        message: 'ui.size: Give a whole number from 10 to 24, not "14.5".',
      },
      leading: change("leading", 1.6, false),
      leadingDevice: change("leading", 1.2, true),
      leadingNotANumber: { _tag: "Invalid", message: leadingRefused("abc") },
      leadingTooBig: { _tag: "Invalid", message: leadingRefused("2.5") },
      leadingTooFine: { _tag: "Invalid", message: leadingRefused("1.555") },
      leadingTooSmall: { _tag: "Invalid", message: leadingRefused("0.9") },
      shared: change("time", "HH:mm:ss", false),
      size: change("size", 20, true),
      spellcheck: change("spellcheck", false, false),
      spellcheckDevice: change("spellcheck", true, true),
      spellcheckWrong: { _tag: "Invalid", message: 'ui.spellcheck: Say on or off, not "maybe".' },
      // The rest of the line after the name's space, exactly: a trailing space is kept.
      suffix: change("suffix", ", ", false),
      suffixAlone: {
        _tag: "Invalid",
        message: "Give ui.suffix a value, or use /unset -device ui.suffix.",
      },
      suffixControl: { _tag: "Invalid", message: suffixRefused("hold no control character") },
      suffixDevice: change("suffix", " -> ", true),
      suffixLongest: change("suffix", "x".repeat(8), false),
      suffixNone: change("suffix", "", false),
      suffixSpace: change("suffix", " ", false),
      suffixTooLong: { _tag: "Invalid", message: suffixRefused("be at most 8 characters") },
      tooBig: { _tag: "Invalid", message: 'ui.size: Give a whole number from 10 to 24, not "25".' },
      tooSmall: {
        _tag: "Invalid",
        message: 'ui.size: Give a whole number from 10 to 24, not "9".',
      },
      twelveHour: change("time", "h:mm:ss a", false),
      twelveHourAnyCase: change("time", "h:mm a", false),
      unknown: {
        _tag: "Invalid",
        message:
          "There is no option ui.palette. Options are named network.<id>.<option>, ui.<option>, store.<option>, uploads.<option>, or previews.<option>.",
      },
      unset: change("activity", undefined, false),
      unsetDevice: change("theme", undefined, true),
      width: change("width", 80, false),
      widthDevice: change("width", 120, true),
      widthFractional: { _tag: "Invalid", message: widthRefused("80.5") },
      widthNone: change("width", "none", false),
      widthTooBig: { _tag: "Invalid", message: widthRefused("401") },
      widthTooSmall: { _tag: "Invalid", message: widthRefused("39") },
      widthWord: { _tag: "Invalid", message: widthRefused("auto") },
      wrong: {
        _tag: "Invalid",
        message: 'ui.activity: Choose one of all, quiet, none, not "loud".',
      },
      // The choices as written, so HH:mm is never read as a 12-hour hh:mm.
      wrongTime: {
        _tag: "Invalid",
        message: 'ui.time: Choose one of HH:mm, HH:mm:ss, h:mm a, h:mm:ss a, none, not "noon".',
      },
    });
  });
});

const owned = (option: string, value: Json | undefined) => ({
  _tag: "Parsed",
  value: [{ _tag: "ChangeOwner", option, value }],
});

const owner: OwnerInForce = {
  options: Schema.decodeSync(OwnerOptions)({
    "previews.maxTotal": 2048,
    "store.s3.accessKeyId": "Owner.store.s3.accessKeyId",
    "store.s3.bucket": "uploads",
    "uploads.maxSize": 1024,
    "uploads.publicUrl": "https://files.example.com",
  }),
  sequence: 4,
};

/**
 * What the options view lists under `store`, `uploads`, and `previews`: each one's name, value, and what
 * it starts as.
 * @param inForce - The options in force, once read.
 * @param held - The Credentials the Vault holds, when known.
 * @returns The rows.
 */
const ownerRows = (inForce: OwnerInForce | undefined, held: ReadonlySet<string> | undefined) =>
  ownerOptionsOf(inForce, held).map((option) => [option.name, option.value, option.starts]);

describe("the options under store, uploads, and previews", () => {
  it("are every field of the contract's Schema, by its full name, each described, with its kind", () => {
    expect({
      described: ownerFields.every((field) => field.description !== ""),
      kinds: Object.fromEntries(ownerFields.map((field) => [field.key, field.kind._tag])),
      names: ownerFields.map((field) => field.key),
    }).toStrictEqual({
      described: true,
      kinds: {
        "previews.maxTotal": "Integer",
        "store.s3.accessKeyId": "Credential",
        "store.s3.bucket": "Text",
        "store.s3.endpoint": "Text",
        "store.s3.region": "Text",
        "store.s3.secretAccessKey": "Credential",
        "uploads.expireAfter": "Integer",
        "uploads.listen": "Text",
        "uploads.maxSize": "Integer",
        "uploads.maxTotal": "Integer",
        "uploads.publicUrl": "Text",
      },
      names: ownerOptionNames,
    });
  });

  it("list each value in force, its default or unset, and a Credential's name and whether it is held", () => {
    expect({
      held: ownerRows(owner, new Set(["Owner.store.s3.accessKeyId"])).slice(1, 3),
      notHeld: ownerRows(owner, new Set()).slice(1, 2),
      read: ownerRows(owner, undefined),
      unread: ownerOptionsOf(undefined, undefined)
        .filter((option) => option.value._tag !== "Unset")
        .map((option) => [option.name, option.value, option.starts]),
    }).toStrictEqual({
      held: [
        [
          "store.s3.accessKeyId",
          { _tag: "Credential", held: true, name: "Owner.store.s3.accessKeyId" },
          "unset",
        ],
        ["store.s3.bucket", { _tag: "Shown", text: "uploads" }, "unset"],
      ],
      notHeld: [
        [
          "store.s3.accessKeyId",
          { _tag: "Credential", held: false, name: "Owner.store.s3.accessKeyId" },
          "unset",
        ],
      ],
      read: [
        ["previews.maxTotal", { _tag: "Shown", text: "2048" }, "1073741824"],
        [
          "store.s3.accessKeyId",
          { _tag: "Credential", held: undefined, name: "Owner.store.s3.accessKeyId" },
          "unset",
        ],
        ["store.s3.bucket", { _tag: "Shown", text: "uploads" }, "unset"],
        ["store.s3.endpoint", { _tag: "Unset" }, "unset"],
        ["store.s3.region", { _tag: "Unset" }, "unset"],
        ["store.s3.secretAccessKey", { _tag: "Unset" }, "unset"],
        ["uploads.expireAfter", { _tag: "Unset" }, "unset"],
        ["uploads.listen", { _tag: "Unset" }, "unset"],
        ["uploads.maxSize", { _tag: "Shown", text: "1024" }, "104857600"],
        ["uploads.maxTotal", { _tag: "Unset" }, "unset"],
        ["uploads.publicUrl", { _tag: "Shown", text: "https://files.example.com" }, "unset"],
      ],
      // Before they are read, each is what it starts as.
      unread: [
        ["previews.maxTotal", { _tag: "Shown", text: "1073741824" }, "1073741824"],
        ["uploads.maxSize", { _tag: "Shown", text: "104857600" }, "104857600"],
      ],
    });
  });

  it("are listed first, filtered, never overridden by a device, and keep the newest read", () => {
    let state = initialOptions;

    for (const event of [
      { _tag: "OwnerRead", owner },
      { _tag: "OwnerRead", owner: { options: ownerDefaults, sequence: 2 } },
    ] satisfies readonly OptionsEvent[]) {
      state = reduceOptions(state, event);
    }

    const forgotten = reduceOptions(state, { _tag: "OwnerForgotten" });

    expect({
      first: listed(state, "")[0]?.name,
      forgotten: forgotten.owner,
      kept: state.owner,
      store: listed(state, "store.s3.b*").map((option) => [option._tag, option.name]),
      uploads: listed(state, "uploads").length,
    }).toStrictEqual({
      first: "previews.maxTotal",
      forgotten: undefined,
      kept: owner,
      store: [["Owner", "store.s3.bucket"]],
      uploads: 5,
    });
  });

  it("resolve only a full name the Schema has", () => {
    expect({
      bucket: resolveOwner("store.s3.bucket")._tag,
      root: resolveOwner("store"),
      typo: resolveOwner("uploads.maxsize"),
    }).toStrictEqual({
      bucket: "Parsed",
      root: {
        _tag: "Invalid",
        message:
          "There is no option store. Options are named network.<id>.<option>, ui.<option>, store.<option>, uploads.<option>, or previews.<option>.",
      },
      typo: {
        _tag: "Invalid",
        message:
          "There is no option uploads.maxsize. Options are named network.<id>.<option>, ui.<option>, store.<option>, uploads.<option>, or previews.<option>.",
      },
    });
  });

  it("parse text by each kind, then by the Schema, saying why it refuses", () => {
    expect({
      bucket: parseOwnerText("store.s3.bucket", "my-bucket"),
      bucketBad: parseOwnerText("store.s3.bucket", "My_Bucket"),
      credential: parseOwnerText("store.s3.secretAccessKey", "hunter2"),
      days: parseOwnerText("uploads.expireAfter", " 30 "),
      daysTooMany: parseOwnerText("uploads.expireAfter", "36501"),
      endpointQuery: parseOwnerText("store.s3.endpoint", "https://s3.example.com/?x=1"),
      endpointSlash: parseOwnerText("store.s3.endpoint", "https://S3.example.com:443/"),
      listen: parseOwnerText("uploads.listen", "127.0.0.1:7668"),
      listenBad: parseOwnerText("uploads.listen", "localhost"),
      maxSize: parseOwnerText("uploads.maxSize", "1048576"),
      maxSizeWord: parseOwnerText("uploads.maxSize", "1MiB"),
      maxSizeZero: parseOwnerText("uploads.maxSize", "0"),
    }).toStrictEqual({
      bucket: { _tag: "Parsed", value: "my-bucket" },
      bucketBad: {
        _tag: "Invalid",
        message:
          "store.s3.bucket must be 3 to 63 lower-case letters, digits, . and -, starting and ending with a letter or digit.",
      },
      credential: {
        _tag: "Invalid",
        message:
          "store.s3.secretAccessKey: A Credential is set by giving its value, which the Vault holds.",
      },
      days: { _tag: "Parsed", value: 30 },
      daysTooMany: {
        _tag: "Invalid",
        message: 'uploads.expireAfter: Give a whole number from 1 to 36500, not "36501".',
      },
      endpointQuery: {
        _tag: "Invalid",
        message:
          "store.s3.endpoint must be an absolute http or https URL, such as https://files.example.com/uploads, with no user, query, or fragment.",
      },
      endpointSlash: { _tag: "Parsed", value: "https://s3.example.com" },
      listen: { _tag: "Parsed", value: "127.0.0.1:7668" },
      listenBad: {
        _tag: "Invalid",
        message:
          "uploads.listen must be host:port, such as 127.0.0.1:7668, with an IPv6 host in brackets.",
      },
      maxSize: { _tag: "Parsed", value: 1_048_576 },
      maxSizeWord: {
        _tag: "Invalid",
        message: `uploads.maxSize: Give a whole number from 1 to ${Number.MAX_SAFE_INTEGER}, not "1MiB".`,
      },
      maxSizeZero: {
        _tag: "Invalid",
        message: `uploads.maxSize: Give a whole number from 1 to ${Number.MAX_SAFE_INTEGER}, not "0".`,
      },
    });
  });

  it("are set and unset with /set and /unset, never for one device, and a Credential's value only in a prompt", () => {
    const secret = "/set store.s3.secretAccessKey hunter2";

    expect({
      alone: read("/set store.s3.bucket"),
      bucket: read("/set store.s3.bucket my-bucket"),
      bucketBad: read("/set store.s3.bucket My_Bucket")._tag,
      credential: read("/set store.s3.accessKeyId"),
      credentialTyped: read(secret),
      device: read("/set -device uploads.maxSize 1024"),
      empty: read("/set uploads.maxSize "),
      filter: read("/set uploads.*"),
      refused: typesCredential(secret),
      unknown: read("/set store.s3.colour blue")._tag,
      unset: read("/unset uploads.maxSize"),
      unsetDevice: read("/unset -device uploads.maxSize"),
    }).toStrictEqual({
      alone: { _tag: "Parsed", value: [{ _tag: "OpenOptions", filter: "store.s3.bucket" }] },
      bucket: owned("store.s3.bucket", "my-bucket"),
      bucketBad: "Invalid",
      credential: {
        _tag: "Parsed",
        value: [{ _tag: "PromptCredential", option: "store.s3.accessKeyId" }],
      },
      credentialTyped: {
        _tag: "Invalid",
        message:
          "A Credential's value is never typed into the composer. It was cleared, and nothing was sent. Use /set store.s3.secretAccessKey alone, which asks for it in a password prompt.",
      },
      device: {
        _tag: "Invalid",
        message:
          "Only an option under ui is kept for this device, as in /set -device ui.theme light.",
      },
      empty: {
        _tag: "Invalid",
        message: "Give uploads.maxSize a value, or use /unset uploads.maxSize.",
      },
      filter: { _tag: "Parsed", value: [{ _tag: "OpenOptions", filter: "uploads.*" }] },
      refused: true,
      unknown: "Invalid",
      unset: owned("uploads.maxSize", undefined),
      unsetDevice: {
        _tag: "Invalid",
        message:
          "Only an option under ui is kept for this device, as in /set -device ui.theme light.",
      },
    });
  });

  it("name a Credential the option names, or one no Network's could ever be named", () => {
    expect({
      derived: derivedOwnerCredential("store.s3.secretAccessKey"),
      named: ownerCredentialFor(
        Schema.decodeSync(OwnerOptions)({
          "previews.maxTotal": 1,
          "store.s3.accessKeyId": "kept",
          "uploads.maxSize": 1,
        }),
        "store.s3.accessKeyId"
      ),
      // A Network's derived names start with its id, which never starts upper-case.
      network: derivedCredential(Schema.decodeSync(NetworkId)("owner"), ["password"]),
      prompt: reduceOptions(initialOptions, {
        _tag: "Prompting",
        prompt: { option: "store.s3.secretAccessKey" },
      }).prompting,
      unnamed: ownerCredentialFor(owner.options, "store.s3.secretAccessKey"),
    }).toStrictEqual({
      derived: "Owner.store.s3.secretAccessKey",
      named: "kept",
      network: { _tag: "Parsed", value: "owner.password" },
      prompt: { name: "store.s3.secretAccessKey", option: "store.s3.secretAccessKey" },
      unnamed: "Owner.store.s3.secretAccessKey",
    });
  });
});
