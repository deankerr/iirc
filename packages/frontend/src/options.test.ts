import { NetworkId, TimelineId } from "@iirc/api";
import { UiOptions } from "@iirc/api/ui";
import { NetworkConfiguration } from "@iirc/client/configuration";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { interpret } from "./commands.ts";
import type { CommandContext, Intent } from "./commands.ts";
import { submit, initialComposers, reduceComposers, draftOf } from "./composer.ts";
import {
  apply,
  credentialFor,
  derivedCredential,
  fields,
  initialOptions,
  listed,
  matches,
  optionsOf,
  parseText,
  reduceOptions,
  resolve,
  set,
  showText,
  starting,
  uiFields,
  uiOptionsOf,
  unset,
} from "./options.ts";
import type { Configuration, Edit, Json, Kind, NetworkOption, OptionsEvent } from "./options.ts";

const libera = Schema.decodeSync(NetworkId)("libera");
const dotted = Schema.decodeSync(NetworkId)("my.net");
const timeline = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");
const decode = Schema.decodeSync(NetworkConfiguration);

const plain: Configuration = decode({
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
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network: libera,
    timeline,
  },
  head: undefined,
  open: timeline,
  panes: 1,
  session: false,
  shown: [],
  timelines: [timeline],
  unread: [],
};

const nowhere: CommandContext = {
  focus: undefined,
  head: undefined,
  open: undefined,
  panes: 1,
  session: false,
  shown: [],
  timelines: [],
  unread: [],
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
        channels: "Names",
        declined: "Texts",
        enabled: "Toggle",
        fallbackEncoding: "Choice",
        highlights: "Texts",
        ircds: "Ircds",
        login: "Tagged",
        nicks: "Texts",
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
        "network.libera.channels",
        "network.libera.channels.#secret.key",
        "network.libera.channels.#iirc.key",
        "network.libera.declined",
        "network.libera.enabled",
        "network.libera.fallbackEncoding",
        "network.libera.highlights",
        "network.libera.ircds",
        "network.libera.login",
        "network.libera.login.account",
        "network.libera.login.credential",
        "network.libera.login.required",
        "network.libera.nicks",
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
      ircds: { starts: undefined, value: { _tag: "Shown", text: "irc.libera.chat/6697" } },
      login: { starts: "none", value: { _tag: "Shown", text: "sasl" } },
      "login.account": { starts: "the first nick", value: { _tag: "Shown", text: "dean" } },
      "login.credential": {
        starts: "libera.login.credential",
        value: { _tag: "Credential", held: true, name: "libera.sasl" },
      },
      "login.required": { starts: "off", value: { _tag: "Shown", text: "on" } },
      nicks: { starts: undefined, value: { _tag: "Shown", text: "dean,dean_" } },
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
        "There is no option libera.nicks. Options are named network.<id>.<option> or ui.<option>.",
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
    .array(fc.constantFrom('"', ",", "\\", " ", "a", "é", "日", "🐱", "/", "-tls", "\t"), {
      maxLength: 8,
    })
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

  it("shows what it reads, once read, for an Ircd list typed any way", () => {
    const kind = kindOf("ircds");

    const typed = fc
      .array(
        fc.tuple(
          simpleHost,
          fc.option(fc.integer({ max: 65_535, min: 1 })),
          fc.constantFrom("", " -tls", " +tls")
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
        "irc.test -tls",
        "::1/6697 -tls",
        "irc.test/0",
        "a -tlsx",
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
      port: valueOf(set(libera, plain, ["ircds"], "127.0.0.1/6670 -tls")).ircds,
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
    const added = read("/network add test 127.0.0.1/6670 -tls bot");

    expect({
      added,
      badId: read("/network add Test irc.test bot"),
      noNick: read("/network add test irc.test"),
      verb: read("/network remove test"),
    }).toStrictEqual({
      added: {
        _tag: "Parsed",
        value: [
          {
            _tag: "AddNetwork",
            configuration: decode({
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
          'A Network\'s id is 1 to 64 lower-case letters, digits, ., _, or -, not "Test". /network add <id> <host>[/port] [-tls] <nick>',
      },
      noNick: {
        _tag: "Invalid",
        message: "Give an Ircd and a nick. /network add <id> <host>[/port] [-tls] <nick>",
      },
      verb: { _tag: "Invalid", message: "Use /network add <id> <host>[/port] [-tls] <nick>." },
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

describe("the options under ui", () => {
  const shared = {
    options: { activity: "quiet", colours: "theme", theme: "dark", themes: [], time: "HH:mm" },
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
        { _tag: "Names", fields: [] },
        { _tag: "Choice", choices: ["HH:mm", "HH:mm:ss", "none"] },
      ],
    });
  });

  it("lists each with the value in effect, the shared one, and this device's override", () => {
    const options = uiOptionsOf(shared, { theme: "light" });
    const before = uiOptionsOf(undefined, {});

    expect({
      before: before.map((one) => [one.name, one.value, one.shared, one.device]),
      options: options.map((one) => [one.name, one.value, one.shared, one.device, one.starts]),
    }).toStrictEqual({
      before: [
        ["ui.activity", { _tag: "Shown", text: "all" }, { _tag: "Unset" }, undefined],
        ["ui.colours", { _tag: "Shown", text: "theme" }, { _tag: "Unset" }, undefined],
        ["ui.theme", { _tag: "Shown", text: "system" }, { _tag: "Unset" }, undefined],
        ["ui.themes", { _tag: "Shown", text: "" }, { _tag: "Unset" }, undefined],
        ["ui.time", { _tag: "Shown", text: "HH:mm" }, { _tag: "Unset" }, undefined],
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
      ],
    });
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
        .slice(-6),
      time: listed(state, "*time", { time: "HH:mm:ss" }).map((option) => option.value),
    }).toStrictEqual({
      kept: shared,
      last: [
        "network.libera.username",
        "ui.activity",
        "ui.colours",
        "ui.theme",
        "ui.themes",
        "ui.time",
      ],
      time: [{ _tag: "Shown", text: "HH:mm:ss" }],
    });
  });

  it("are set and unset with /set and /unset, for every device or with -device for this one", () => {
    expect({
      alone: read("/set ui.time"),
      anyCase: read("/set ui.time hh:mm:ss"),
      device: read("/set -device ui.theme light"),
      deviceAlone: read("/set -device"),
      deviceNetwork: read("/set -device network.libera.nicks a"),
      empty: read("/set ui.time "),
      shared: read("/set ui.time HH:mm:ss"),
      unknown: read("/set ui.palette dusk"),
      unset: read("/unset ui.activity"),
      unsetDevice: read("/unset -device ui.theme"),
      wrong: read("/set ui.activity loud"),
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
      shared: change("time", "HH:mm:ss", false),
      unknown: {
        _tag: "Invalid",
        message:
          "There is no option ui.palette. Options are named network.<id>.<option> or ui.<option>.",
      },
      unset: change("activity", undefined, false),
      unsetDevice: change("theme", undefined, true),
      wrong: {
        _tag: "Invalid",
        message: 'ui.activity: Choose one of all, quiet, none, not "loud".',
      },
    });
  });
});
