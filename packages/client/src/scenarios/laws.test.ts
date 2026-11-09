/**
 * The four laws over the Client and its registry. With no Features on the floor, `inert`
 * and `deactivates` hold trivially, but they run here so that stage 2's Features inherit
 * them by joining the registry.
 */
import { describe, expect, it } from "vitest";

import { client, makeClient } from "../core.ts";
import type { Feature, Meant } from "../feature.ts";
import { CapName, FeatureName } from "../ids.ts";
import type { MemberKnowledge } from "../known.ts";
import { register, registry } from "../registry.ts";
import type { State } from "../state.ts";
import type { Subject } from "../testing/index.ts";
import {
  configured,
  deactivates,
  inert,
  joined,
  refines,
  registered,
  replays,
} from "../testing/index.ts";

const base = configured();

const subject: Subject<State> = {
  caps: ["multi-prefix", "server-time", "away-notify"],
  client,
  configuration: base,
  features: registry,
  transcript: (caps) =>
    `${
      registered(base, { offered: caps }) + joined(base, "#iirc", ["@op", "+voiced", "peer"])
    }<< :peer!u@h PRIVMSG #iirc :hello\n<< :op!u@h MODE #iirc +o peer\n`,
};

describe("the laws", () => {
  it("inert: a Feature that is off changes nothing", () => {
    expect(() => {
      inert(subject);
    }).not.toThrow();
  });

  it("refines: more caps only make facts more certain", () => {
    expect(() => {
      refines(subject);
    }).not.toThrow();
  });

  it("replays: every set of caps replays exactly, with plain State", () => {
    expect(() => {
      replays(subject);
    }).not.toThrow();
  });

  it("deactivates: after CAP DEL, as if the cap had never been", () => {
    expect(() => {
      deactivates(subject, {
        after: () => "+1s\n<< :other!u@h JOIN #iirc\n<< :peer!u@h AWAY :out\n",
      });
    }).not.toThrow();
  });
});

const complete = (member: MemberKnowledge): MemberKnowledge =>
  member.prefixes._tag === "Partial"
    ? {
        ...member,
        prefixes: {
          _tag: "Known",
          at: member.prefixes.at,
          from: member.prefixes.from,
          value: member.prefixes.atLeast,
        },
      }
    : member;

// A Feature as `multi-prefix` will be, to show the laws see through the seam.
const listing: Feature = {
  meaning: (meant) => ({
    value: meant.map((each): Meant =>
      each._tag === "Listed" ? { ...each, members: each.members.map(complete) } : each
    ),
  }),
  name: FeatureName.make("multi-prefix"),
  needs: { caps: [CapName.make("multi-prefix")] },
  own: undefined,
};

describe("the laws, with a Feature in the registry", () => {
  const withListing: Subject<State> = {
    ...subject,
    client: makeClient([register(listing)]),
    features: [listing],
  };

  it("inert, refines, and replays hold", () => {
    expect(() => {
      inert(withListing);
      refines(withListing);
      replays(withListing);
    }).not.toThrow();
  });
});
