/**
 * The four laws over the Client and its registry, across every set of caps `across`
 * gives: none, each alone, and every pair. `UTF8ONLY` is an ISUPPORT token, not a cap, so
 * the transcript sends it as a token when the set names it, and the laws treat it as a
 * cap of the `utf8only` Feature. Deleting it is a `005 -UTF8ONLY`, which `utf8.test.ts`
 * plays, so `deactivates` ranges over the caps alone.
 *
 * `deactivates` leaves out `sasl` too. Deleting it after `903` changes nothing, because
 * Self is logged in and the account stays known, but a run that never had it never
 * logged in, so the two cannot match. `sasl.test.ts` plays the deletion instead.
 */
import { CredentialName } from "@iirc/protocol/line";
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { CapName } from "../ids.ts";
import { registry } from "../registry.ts";
import type { State } from "../state.ts";
import type { LawFeature, Subject } from "../testing/index.ts";
import {
  configured,
  deactivates,
  floorIsupport,
  inert,
  joined,
  refines,
  registered,
  replays,
} from "../testing/index.ts";

const base = configured({
  login: { _tag: "Sasl", account: "iirc", credential: CredentialName.make("pw"), required: false },
});

const token = CapName.make("UTF8ONLY");

// The laws read a Feature's `needs.caps`, so the token stands in as one.
const features: readonly LawFeature[] = registry.map((feature) =>
  feature.needs.tokens === undefined ? feature : { ...feature, needs: { caps: [token] } }
);

const caps = features.flatMap(({ needs }) => needs.caps ?? []);

// What the Client asks for: the caps of each Feature whose caps are all offered.
const requested = (offered: readonly string[]): readonly string[] =>
  registry
    .filter(({ needs }) => (needs.caps ?? []).every((cap) => offered.includes(cap)))
    .flatMap(({ needs }) => needs.caps ?? []);

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// A Session with something for every Feature to refine: tags, a batch, a labelled echo,
// prefixes, away status, and bytes that are not UTF-8.
const transcript = (set: readonly CapName[]): string => {
  const offered = set.filter((cap) => cap !== token);

  return [
    registered(base, {
      isupport: set.includes(token) ? [...floorIsupport, token] : floorIsupport,
      offered,
      requested: requested(offered),
    }),
    joined(base, "#iirc", ["@+op", "+voiced", "peer"]),
    lines(
      "<< @msgid=m1;time=2026-01-01T00:00:00.500Z;+draft/reply=m0 :peer!u@h PRIVMSG #iirc :hello",
      "<< :irc.test BATCH +b netsplit irc.hub other.host",
      "<< @batch=b :gone!u@h QUIT :irc.hub other.host",
      "<< :irc.test BATCH -b",
      "<< :peer!u@h AWAY :out",
      "<<\\ :peer!u@h PRIVMSG #iirc :caf\\xe9",
      "!! say #iirc :hi",
      "<< @label=l1;msgid=m2 :iirc!~iirc@iirc.test PRIVMSG #iirc :hi",
      "<< :op!u@h MODE #iirc +v peer"
    ),
  ].join("");
};

const subject: Subject<State> = { caps, client, configuration: base, features, transcript };

// Each law replays the transcript for each of 56 sets of caps, and `inert` and
// `deactivates` several times over, so they take longer than a scenario.
describe("the laws, over every Feature", { timeout: 60_000 }, () => {
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
      deactivates(
        { ...subject, caps: caps.filter((cap) => cap !== token && cap !== "sasl") },
        {
          after: (without) =>
            lines(
              "+1s",
              // A prefix a listing made complete, changed after the cap is gone.
              "<< :op!u@h MODE #iirc +o voiced",
              "<< :other!u@h JOIN #iirc",
              "<< @msgid=m3;time=2026-01-01T00:00:01.500Z :peer!u@h PRIVMSG #iirc :after",
              "<< :irc.test BATCH +c netsplit irc.hub other.host",
              "<< @batch=c :other!u@h PRIVMSG #iirc :in a batch",
              "<< :irc.test BATCH -c",
              "<< :voiced!u@h AWAY :later",
              "!! say #iirc :again",
              // The Ircd echoes only with both caps.
              ...(without.includes(CapName.make("echo-message")) &&
              without.includes(CapName.make("labeled-response"))
                ? ["<< @label=l2 :iirc!~iirc@iirc.test PRIVMSG #iirc :again"]
                : [])
            ),
        }
      );
    }).not.toThrow();
  });
});
