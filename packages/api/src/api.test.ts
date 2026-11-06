import { defaultTuning } from "@iirc/lifecycle/tuning";
import { Predicate, Result, Schema, SchemaIssue } from "effect";
import { describe, expect, it } from "vitest";

import {
  apiVersion,
  Configuration,
  LoggedMessage,
  NetworkSettings,
  requestParseOptions,
  TuningSettings,
} from "./api.ts";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

// What a failed decoding found, with each path as the API reports it.
const issuesOf = <A>(result: Result.Result<A, Schema.SchemaError>) =>
  Result.isFailure(result)
    ? formatIssues(result.failure.issue).issues.map(({ message, path = [] }) => ({
        message,
        path: path.map((segment) =>
          Predicate.hasProperty(segment, "key") ? segment.key : segment
        ),
      }))
    : [];

// As the API parses a body, so that what passes here is what the Daemon accepts.
const asRequest = { errors: "all", ...requestParseOptions } as const;

const decodeSettings = Schema.decodeUnknownResult(NetworkSettings, asRequest);

const decodeConfiguration = Schema.decodeUnknownResult(Configuration, asRequest);

const settingsIssues = (settings: Schema.Json) => issuesOf(decodeSettings(settings));

const base = { id: "libera", identity: { nick: "iirc" }, ircds: [{ host: "irc.libera.chat" }] };

const tuningIssues = (tuning: Schema.Json) => settingsIssues({ ...base, tuning });

// The part of the JSON Schema a Frontend reads Tuning's defaults from.
const PublishedTuning = Schema.Struct({
  properties: Schema.Record(
    Schema.String,
    Schema.Struct({ default: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Boolean])) })
  ),
});

describe("a Network's Tuning overrides (CONF-3)", () => {
  it("leaves the spec's defaults alone when given nothing", () => {
    expect(Schema.decodeUnknownSync(NetworkSettings)(base).tuning).toStrictEqual({});
  });

  it("keeps only what it is given", () => {
    const overrides = { floodBurst: 2, lagCheckMillis: 1000, silenceMillis: 5000 };

    expect(Schema.decodeSync(TuningSettings)(overrides)).toStrictEqual(overrides);
  });

  it("has a field for everything lifecycle's Tuning has, each number and switch with its default", () => {
    const { properties } = Schema.decodeUnknownSync(PublishedTuning)(
      Schema.toJsonSchemaDocument(TuningSettings).schema
    );

    expect(Object.keys(properties).toSorted()).toStrictEqual(
      [...Object.keys(defaultTuning), "casemapping", "encoding"].toSorted()
    );
    expect(
      Object.fromEntries(
        Object.entries(properties).flatMap(([key, field]) =>
          field.default === undefined ? [] : [[key, field.default]]
        )
      )
    ).toStrictEqual(defaultTuning);
  });

  it.each([
    ["silenceMilis", { silenceMilis: 5000 }],
    ["toString", { toString: 5 }],
    ["constructor", { constructor: 5 }],
    ["hasOwnProperty", { hasOwnProperty: 5 }],
  ])("names %s, which is not a Tuning number, at its path", (key, tuning) => {
    expect(tuningIssues(tuning)).toStrictEqual([
      { message: "Expected no excess property", path: ["tuning", key] },
    ]);
  });

  it.each([
    [{ silenceMillis: -1 }, "silenceMillis"],
    [{ silenceMillis: 0 }, "silenceMillis"],
    [{ silenceMillis: 1.5 }, "silenceMillis"],
    [{ silenceMillis: "soon" }, "silenceMillis"],
    [{ reconnectMaxMillis: 2_147_483_648 }, "reconnectMaxMillis"],
    [{ floodIntervalMillis: 0 }, "floodIntervalMillis"],
    [{ reconnectInitialMillis: 0 }, "reconnectInitialMillis"],
    // LIVE-9: a `QUIT` wait of 0 would drop the `QUIT`.
    [{ quitWaitMillis: 0 }, "quitWaitMillis"],
    // LIVE-3: lag checks stay at least 100 ms apart, past flood control as they are.
    [{ lagCheckMillis: 99 }, "lagCheckMillis"],
  ])("refuses %j, at the number's own path", (tuning, key) => {
    const issues = tuningIssues(tuning);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toStrictEqual(["tuning", key]);
  });

  it("RUN-3: refuses a QUIT wait past 10 seconds, so that a stop stays prompt", () => {
    expect(tuningIssues({ quitWaitMillis: 10_000 })).toStrictEqual([]);
    expect(tuningIssues({ quitWaitMillis: 60_000 })).toStrictEqual([
      { message: "Expected a value between 1 and 10000", path: ["tuning", "quitWaitMillis"] },
    ]);
  });

  it("allows 0 only where nothing is paced by it", () => {
    expect(tuningIssues({ drainMillis: 0 })).toStrictEqual([]);
    expect(tuningIssues({ lagCheckMillis: 100, silenceMillis: 101 })).toStrictEqual([]);
  });

  it.each([
    [{ silenceMillis: 60_000 }, "silenceMillis", "must be above lagCheckMillis, which is 60000"],
    [{ lagCheckMillis: 90_000 }, "lagCheckMillis", "must be below silenceMillis, which is 90000"],
    [
      { lagCheckMillis: 5000, silenceMillis: 4000 },
      "silenceMillis",
      "must be above lagCheckMillis, which is 5000",
    ],
    [
      { reconnectInitialMillis: 300_001 },
      "reconnectInitialMillis",
      "must not be above reconnectMaxMillis, which is 300000",
    ],
    [
      { reconnectMaxMillis: 4999 },
      "reconnectMaxMillis",
      "must not be below reconnectInitialMillis, which is 5000",
    ],
  ])(
    "LIVE-2, LIVE-4: refuses %j against the other number, at the one the Owner set",
    (tuning, key, message) => {
      expect(tuningIssues(tuning)).toStrictEqual([{ message, path: ["tuning", key] }]);
    }
  );

  it("takes a first delay equal to the longest", () => {
    expect(tuningIssues({ reconnectInitialMillis: 1, reconnectMaxMillis: 1 })).toStrictEqual([]);
  });

  it("refuses what is not an object", () => {
    for (const tuning of ["silenceMillis=5", [], 5]) {
      expect(tuningIssues(tuning)).toStrictEqual([
        { message: "Expected object", path: ["tuning"] },
      ]);
    }
  });
});

describe("the encoding, the casemapping, and CTCP replies in Tuning (CONF-3)", () => {
  it("MSG-4, KNOW-3, PROT-3, PROT-4: keeps each when given, as given", () => {
    const tuning = {
      casemapping: "ascii",
      ctcpNetworkLimit: 2,
      ctcpNetworkWindowMillis: 30_000,
      ctcpPing: false,
      ctcpTime: true,
      ctcpUserIntervalMillis: 0,
      ctcpVersion: false,
      encoding: "Windows-1251",
    };

    expect(tuningIssues(tuning)).toStrictEqual([]);
    expect(Schema.decodeUnknownSync(TuningSettings)(tuning)).toStrictEqual(tuning);
  });

  it("PROT-3: publishes VERSION and PING on and TIME off, and no encoding or mapping", () => {
    expect({
      ctcpPing: defaultTuning.ctcpPing,
      ctcpTime: defaultTuning.ctcpTime,
      ctcpVersion: defaultTuning.ctcpVersion,
      encoding: defaultTuning.encoding,
      forced: defaultTuning.casemapping,
    }).toStrictEqual({
      ctcpPing: true,
      ctcpTime: false,
      ctcpVersion: true,
      encoding: undefined,
      forced: undefined,
    });
  });

  it("PROT-4: publishes one reply per User per 10 seconds and 5 a minute per Network", () => {
    expect([
      defaultTuning.ctcpUserIntervalMillis,
      defaultTuning.ctcpNetworkLimit,
      defaultTuning.ctcpNetworkWindowMillis,
    ]).toStrictEqual([10_000, 5, 60_000]);
  });

  it.each(["utf-8", "shift_jis", "ISO-8859-2", " koi8-r ", "latin1"])(
    "MSG-4: takes %j, a label this runtime decodes with",
    (encoding) => {
      expect(tuningIssues({ encoding })).toStrictEqual([]);
    }
  );

  it.each(["", "klingon", "x-user-defined", "utf-7"])(
    "MSG-4, API-3: refuses %j, which no decoder here reads, at its path",
    (encoding) => {
      expect(tuningIssues({ encoding })).toStrictEqual([
        {
          message:
            "is not an encoding label this Daemon can decode, such as windows-1251 or shift_jis",
          path: ["tuning", "encoding"],
        },
      ]);
    }
  );

  it("KNOW-3: takes each mapping @iirc/state knows, and refuses any other at its path", () => {
    for (const casemapping of ["ascii", "rfc1459", "rfc1459-strict", "rfc8265"]) {
      expect(tuningIssues({ casemapping })).toStrictEqual([]);
    }

    expect(tuningIssues({ casemapping: "strict-rfc1459" })).toHaveLength(1);
    expect(tuningIssues({ casemapping: "permissive" })[0]?.path).toStrictEqual([
      "tuning",
      "casemapping",
    ]);
  });

  it.each([
    [{ ctcpNetworkLimit: 0 }, "ctcpNetworkLimit"],
    // Standing holds 100 reply times, so a larger limit could not be counted.
    [{ ctcpNetworkLimit: 101 }, "ctcpNetworkLimit"],
    [{ ctcpNetworkWindowMillis: 0 }, "ctcpNetworkWindowMillis"],
    [{ ctcpUserIntervalMillis: -1 }, "ctcpUserIntervalMillis"],
    [{ ctcpVersion: "yes" }, "ctcpVersion"],
    [{ ctcpTime: 1 }, "ctcpTime"],
  ])("PROT-4, API-3: refuses %j at its path", (tuning, key) => {
    const issues = tuningIssues(tuning);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toStrictEqual(["tuning", key]);
  });
});

describe("a Network's settings (CONF-3)", () => {
  it("refuses a Channel listed twice, however it is spelt, at the second", () => {
    expect(
      settingsIssues({ ...base, channels: [{ name: "#a" }, { name: "#b" }, { name: "#A" }] })
    ).toStrictEqual([{ message: "is the same Channel as another", path: ["channels", 2, "name"] }]);
  });

  it("takes different Channels", () => {
    expect(settingsIssues({ ...base, channels: [{ name: "#a" }, { name: "#b" }] })).toStrictEqual(
      []
    );
  });
});

describe("all of Configuration (CONF-6)", () => {
  it("refuses a second Network of one ID, at its ID", () => {
    expect(issuesOf(decodeConfiguration({ networks: [base, base] }))).toStrictEqual([
      { message: "is another Network's ID", path: ["networks", 1, "id"] },
    ]);
  });

  it("holds each Network to the same rules, at its own path", () => {
    expect(
      issuesOf(
        decodeConfiguration({
          networks: [base, { ...base, id: "oftc", tuning: { laneLimit: 0 } }],
        })
      )
    ).toStrictEqual([
      {
        message: "Expected a value between 1 and 2147483647",
        path: ["networks", 1, "tuning", "laneLimit"],
      },
    ]);
  });
});

describe("a Message (MSG-1, API-5)", () => {
  const message = {
    at: 1,
    kind: "ACTION",
    network: "libera",
    place: { _tag: "Channel", key: "#iirc", name: "#IIRC" },
    sender: "bob",
    sequence: 2,
    target: "#IIRC",
    text: "waves",
  };

  it("MSG-1, API-5: version 2 names an ACTION as a kind of its own, with its own text", () => {
    expect(apiVersion).toBe(2);
    expect(Schema.decodeUnknownSync(LoggedMessage)(message)).toStrictEqual(message);
    expect(
      Schema.decodeUnknownSync(LoggedMessage)({ ...message, statusmsg: "@", target: "@#IIRC" })
    ).toMatchObject({ statusmsg: "@" });
  });

  it("MSG-1: no other kind is a Message", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(LoggedMessage)({ ...message, kind: "CTCP" }))
    ).toBeTruthy();
  });
});
