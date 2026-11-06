import { assert, describe, it } from "@effect/vitest";
import { CursorStale, NetworkNotFound, NotAChannel, TargetNotFound } from "@iirc/api";
import type {
  ActivityCursor,
  ChannelDetails,
  LogEntry,
  LoggedActivity,
  MembersCursor,
} from "@iirc/api";
import { LogReader, pageBytes, spanBytes } from "@iirc/log";
import { eventually, fakeIrcd } from "@iirc/session/testing";
import type { FakeIrcd } from "@iirc/session/testing";
import { Transport } from "@iirc/session/transport";
import { Effect, Layer, Schema } from "effect";

import {
  clientWith,
  coreFor,
  inTempDirectory,
  invalidRequest,
  localKey,
  noKeyring,
  rawWith,
  servingWith,
  statusOf,
  version,
} from "./daemon.fixture.ts";
import type { Client, RawRequests } from "./daemon.fixture.ts";

const network = "libera";

interface Harness {
  readonly client: Client;
  readonly ircd: FakeIrcd;
  readonly raw: RawRequests;
}

const settings = {
  channels: [],
  connectCommands: [],
  credentials: {},
  enabled: true,
  id: network,
  identity: { alternates: [], nick: "iirc", realname: "I IRC", username: "user" },
  ircds: [{ host: "irc.test", port: 6697, tls: false }] as const,
  name: "Libera",
  quitReason: "going",
  services: [],
  // A reconnect within a test's time.
  tuning: { reconnectInitialMillis: 10 },
};

const welcomed = ({ client, ircd }: Harness) =>
  Effect.gen(function* () {
    const status = statusOf(client, network);

    yield* eventually(status, ({ phase }) => phase === "registering");
    yield* ircd.read(":ircd 001 iirc :Welcome\r\n");
    yield* eventually(status, ({ phase }) => phase === "session");
  });

/** How a test's Daemon reads the Log: in process, or on the Worker, as the binary does. */
type Reading = "in process" | "on its Worker";

const withSession = <A, E, R>(
  test: (harness: Harness) => Effect.Effect<A, E, R>,
  reading: Reading = "in process"
) =>
  inTempDirectory((dataDir) =>
    Effect.gen(function* () {
      const key = yield* localKey(dataDir);
      const ircd = yield* fakeIrcd();

      return yield* Effect.gen(function* () {
        const client = yield* clientWith(key);
        const harness = { client, ircd, raw: yield* rawWith(key) };

        yield* client.networks.add({ payload: settings });
        yield* welcomed(harness);

        return yield* test(harness);
      }).pipe(
        Effect.provide(
          servingWith(
            coreFor(
              { dataDir, version },
              {
                keyring: noKeyring,
                transport: Layer.succeed(Transport, ircd.transport),
                ...(reading === "on its Worker" && { reader: LogReader.layer({ dataDir }) }),
              }
            )
          )
        )
      );
    }).pipe(Effect.scoped)
  );

const lineOf = (text: string) => `${text}\r\n`;

const say = (ircd: FakeIrcd, ...lines: readonly string[]) =>
  ircd.read(lineOf(lines[0] ?? ""), ...lines.slice(1).map(lineOf));

const everything = { query: { after: 0, limit: 1000 } };

const inbound = (entries: readonly LogEntry[]) =>
  entries.flatMap((entry) =>
    entry._tag === "Line" && entry.direction === "inbound" ? [entry] : []
  );

// The sequence of the first inbound Line that says `text`, once it is recorded.
const recorded = ({ client }: Harness, text: string) =>
  Effect.map(
    eventually(client.daemon.entries(everything), (entries) =>
      inbound(entries).some((entry) => entry.text === text)
    ),
    (entries) => inbound(entries).find((entry) => entry.text === text)?.sequence ?? 0
  );

const target = (
  { client }: Harness,
  name: string,
  query: { after?: MembersCursor; limit?: number } = {}
) =>
  client.networks.target({
    params: { id: network, target: name },
    query: { limit: 1000, ...query },
  });

const members = ({ members: { items } }: ChannelDetails) =>
  items.map(({ nick, prefixes, symbols }) => `${symbols}${nick}:${prefixes}`);

const joined = [
  ":ircd 005 iirc PREFIX=(ov)@+ CHANTYPES=# CHANMODES=b,k,l,nt :are supported",
  ":iirc!u@h JOIN #IIRC",
  ":ircd 332 iirc #IIRC :\u0002Welcome\u0002 to \u000304red",
  ":ircd 333 iirc #IIRC alice!a@h 1700000000",
  ":ircd 353 iirc = #IIRC :iirc @alice +bob carol",
  ":ircd 366 iirc #IIRC :End of /NAMES list.",
  ":ircd 324 iirc #IIRC +ntkl secret 10",
  ":ircd 329 iirc #IIRC 1600000000",
  ":alice!a@alice.host PRIVMSG #IIRC :hi",
];

// Self shares three Channels with five Users, who then all quit in one read: a
// netsplit, five Entries of three rows each (KNOW-8).
const storm = (harness: Harness) =>
  Effect.gen(function* () {
    const users = ["u1", "u2", "u3", "u4", "u5"];

    yield* say(
      harness.ircd,
      ...["#a", "#b", "#c"].flatMap((channel) => [
        `:iirc!u@h JOIN ${channel}`,
        `:ircd 353 iirc = ${channel} :iirc ${users.join(" ")}`,
        `:ircd 366 iirc ${channel} :End`,
      ])
    );
    yield* recorded(harness, ":ircd 366 iirc #c :End");
    yield* say(harness.ircd, ...users.map((nick) => `:${nick}!x@split QUIT :*.net *.split`));

    return yield* recorded(harness, ":u5!x@split QUIT :*.net *.split");
  });

// Watches the event loop, and says the longest it stood still, which is what a read costs
// every append waiting behind it (LOG-11).
const lagProbe = () => {
  let last = performance.now();
  let longest = 0;

  const timer = setInterval(() => {
    const now = performance.now();

    longest = Math.max(longest, now - last);
    last = now;
  }, 1);

  return {
    stop: () => {
      clearInterval(timer);

      return Math.max(longest, performance.now() - last);
    },
  };
};

describe("reading what the Network knows", () => {
  describe("GET /networks/{id}", () => {
    it.live("KNOW-1, KNOW-2, API-6: gives Self and every token held, with `at`", () =>
      withSession((harness) =>
        Effect.gen(function* () {
          const { client, ircd } = harness;
          const read = client.networks.get({ params: { id: network } });

          yield* say(
            ircd,
            ":ircd 005 iirc NETWORK=Test EXCEPTS CHANTYPES=# :are supported",
            ":ircd 221 iirc +iw",
            ":iirc!~me@host.example JOIN #k",
            ":ircd 306 iirc :You have been marked as being away"
          );

          const away = yield* recorded(
            harness,
            ":ircd 306 iirc :You have been marked as being away"
          );

          const { known, status } = yield* eventually(read, ({ known: { at } }) => at >= away);

          assert.deepStrictEqual(known.self, {
            away: true,
            host: "host.example",
            modes: "iw",
            user: "~me",
          });
          // Self's nick and how names compare are status's, said once.
          assert.strictEqual(status.self, "iirc");
          assert.deepInclude(known.isupport.tokens, {
            CHANTYPES: "#",
            EXCEPTS: "",
            NETWORK: "Test",
          });
          assert.isFalse(known.isupport.tokensDropped);

          // Taken back, a token is absent, which an empty one is not.
          yield* say(ircd, ":ircd 005 iirc -EXCEPTS :are supported");

          const taken = yield* recorded(harness, ":ircd 005 iirc -EXCEPTS :are supported");
          const after = yield* eventually(read, ({ known: { at } }) => at >= taken);

          assert.notProperty(after.known.isupport.tokens, "EXCEPTS");
          assert.propertyVal(after.known.isupport.tokens, "NETWORK", "Test");

          // With no Session, there is no Self.
          yield* ircd.hangUp;

          const gone = yield* eventually(read, ({ status: { phase } }) => phase !== "session");

          assert.isNull(gone.known.self);
          assert.deepStrictEqual(gone.known.isupport.tokens, {});
        })
      )
    );
  });

  describe("GET /networks/{id}/targets/{target}", () => {
    it.live(
      "KNOW-4, KNOW-7, API-6: gives a Channel as folded, and `at` advances with it",
      () =>
        withSession((harness) =>
          Effect.gen(function* () {
            yield* say(harness.ircd, ...joined);

            const said = yield* recorded(harness, ":alice!a@alice.host PRIVMSG #IIRC :hi");

            // Any spelling the mapping allows finds it (KNOW-3).
            const first = yield* eventually(target(harness, "#iirc"), ({ at }) => at >= said);

            assert.deepInclude(first, {
              _tag: "Channel",
              createdAt: 1_600_000_000_000,
              key: "#iirc",
              name: "#IIRC",
              network,
              uncertain: { members: false, modes: false },
            });
            assert.deepStrictEqual(first.topic, {
              setAt: 1_700_000_000_000,
              setBy: "alice!a@h",
              spans: [
                { bold: true, text: "Welcome" },
                { text: " to " },
                { foreground: { _tag: "Palette", index: 4 }, text: "red" },
              ],
              text: "\u0002Welcome\u0002 to \u000304red",
            });
            // CRED-4: the key is set, and its value is not given.
            assert.deepStrictEqual(first.modes, [
              { letter: "k" },
              { letter: "l", param: "10" },
              { letter: "n" },
              { letter: "t" },
            ]);
            assert.notInclude(JSON.stringify(first), "secret");
            assert.deepStrictEqual(members(first), ["@alice:o", "+bob:v", "carol:", "iirc:"]);
            assert.deepInclude(first.members.items[0], { host: "alice.host", user: "a" });
            assert.deepInclude(first.members, { count: 4, next: null });

            yield* say(harness.ircd, ":alice!a@alice.host MODE #IIRC -o alice");
            yield* say(harness.ircd, ":bob!b@h TOPIC #IIRC :\u001Fnew\u001F topic");
            yield* say(harness.ircd, ":carol!c@h QUIT :bye");

            const quit = yield* recorded(harness, ":carol!c@h QUIT :bye");
            const second = yield* eventually(target(harness, "#IIRC"), ({ at }) => at >= quit);

            assert.deepStrictEqual(members(second), ["alice:", "+bob:v", "iirc:"]);
            assert.deepInclude(second.topic, {
              setBy: "bob!b@h",
              spans: [{ text: "new", underline: true }, { text: " topic" }],
              text: "\u001Fnew\u001F topic",
            });
            assert.isAbove(second.at, first.at);

            // `at` is no later than anything committed by the time the read answered.
            const { head } = yield* harness.client.daemon.status();

            assert.isAtMost(second.at, head ?? 0);
          })
        ),
      { timeout: 60_000 }
    );

    it.live(
      "API-3: says, typed, that a Target is not held, is a User, or the Network is unknown",
      () =>
        withSession((harness) =>
          Effect.gen(function* () {
            yield* say(harness.ircd, ...joined);
            yield* recorded(harness, ":alice!a@alice.host PRIVMSG #IIRC :hi");

            assert.deepStrictEqual(
              yield* Effect.flip(target(harness, "#elsewhere")),
              new TargetNotFound({ network, target: "#elsewhere" })
            );
            assert.deepStrictEqual(
              yield* Effect.flip(target(harness, "alice")),
              new NotAChannel({ network, target: "alice" })
            );
            assert.deepStrictEqual(
              yield* Effect.flip(
                harness.client.networks.target({
                  params: { id: "oftc", target: "#IIRC" },
                  query: { limit: 10 },
                })
              ),
              new NetworkNotFound({ network: "oftc" })
            );

            // `#` travels as `%23`, and a name with a space is no Target.
            const raw = yield* harness.raw.get(`/api/networks/${network}/targets/%23iirc`);

            assert.strictEqual(raw.status, 200);
            assert.deepInclude(yield* Effect.orDie(raw.json), { name: "#IIRC" });

            const spaced = yield* invalidRequest(
              yield* harness.raw.get(`/api/networks/${network}/targets/%23a%20b`)
            );

            assert.deepStrictEqual(spaced.issues[0]?.path, ["params", "target"]);

            const tooMany = yield* invalidRequest(
              yield* harness.raw.get(`/api/networks/${network}/targets/%23iirc?limit=1001`)
            );

            assert.deepStrictEqual(tooMany.issues[0]?.path, ["query", "limit"]);
          })
        )
    );

    it.live("KNOW-4: pages a large Channel's members by cursor, each page bounded", () =>
      withSession((harness) =>
        Effect.gen(function* () {
          const nicks = [
            "iirc",
            ...Array.from({ length: 2500 }, (_, index) => `m${String(index).padStart(4, "0")}`),
          ];

          const names = [];

          for (let start = 0; start < nicks.length; start += 50) {
            names.push(`:ircd 353 iirc = #big :${nicks.slice(start, start + 50).join(" ")}`);
          }

          yield* say(harness.ircd, ":iirc!u@h JOIN #big", ...names, ":ircd 366 iirc #big :End");
          yield* recorded(harness, ":ircd 366 iirc #big :End");

          const pages: ChannelDetails[] = [];
          let after: MembersCursor | undefined;

          do {
            const page: ChannelDetails = yield* target(harness, "#big", {
              limit: 1000,
              ...(after !== undefined && { after }),
            });

            pages.push(page);
            after = page.members.next ?? undefined;
          } while (after !== undefined);

          assert.deepStrictEqual(
            pages.map(({ members: { items } }) => items.length),
            [1000, 1000, 501]
          );
          assert.deepStrictEqual(
            pages.flatMap(({ members: { items } }) => items.map(({ nick }) => nick)),
            nicks.toSorted()
          );
          assert.isTrue(pages.every(({ members: { count } }) => count === 2501));
        })
      )
    );
  });

  it.live("KNOW-3: refuses a members cursor folded under a mapping no longer in force", () =>
    withSession((harness) =>
      Effect.gen(function* () {
        // Under rfc1459, `[` folds to `{`, which sorts after every letter.
        yield* say(
          harness.ircd,
          ":iirc!u@h JOIN #map",
          ":ircd 353 iirc = #map :iirc z [a [b",
          ":ircd 366 iirc #map :End"
        );
        yield* recorded(harness, ":ircd 366 iirc #map :End");

        const first = yield* target(harness, "#map", { limit: 2 });

        assert.deepStrictEqual(
          first.members.items.map(({ nick }) => nick),
          ["iirc", "z"]
        );
        assert.deepStrictEqual(first.members.next, { after: "z", casemapping: "rfc1459" });

        const raw = yield* harness.raw.get(`/api/networks/${network}/targets/%23map?limit=2`);

        const { members: wire } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ members: Schema.Struct({ next: Schema.String }) })
        )(yield* Effect.orDie(raw.json));

        assert.strictEqual(wire.next, "rfc1459:z", "one opaque value on the wire");

        // Under ascii `[a` and `[b` sort first, so resuming after `z` would skip them.
        yield* say(harness.ircd, ":ircd 005 iirc CASEMAPPING=ascii :are supported");
        yield* recorded(harness, ":ircd 005 iirc CASEMAPPING=ascii :are supported");

        assert.deepStrictEqual(
          yield* Effect.flip(
            target(harness, "#map", {
              limit: 2,
              ...(first.members.next !== null && { after: first.members.next }),
            })
          ),
          new CursorStale({ casemapping: "rfc1459", inForce: "ascii" })
        );

        const again = yield* target(harness, "#map", { limit: 1000 });

        assert.deepStrictEqual(
          again.members.items.map(({ nick }) => nick),
          ["[a", "[b", "iirc", "z"]
        );

        const forged = yield* invalidRequest(
          yield* harness.raw.get(`/api/networks/${network}/targets/%23map?after=nonsense:z`)
        );

        assert.deepStrictEqual(forged.issues[0]?.path, ["query", "after"]);
      })
    )
  );

  describe("GET /activity", () => {
    it.live("MSG-5, API-2: pages through a QUIT storm, and resumes inside an Entry", () =>
      withSession((harness) =>
        Effect.gen(function* () {
          const last = yield* storm(harness);
          const { client } = harness;

          const whole = yield* eventually(
            client.daemon.activity({ query: { after: { sequence: 0 }, limit: 1000, network } }),
            ({ activity }) => activity.some(({ sequence }) => sequence === last)
          );

          const quits = whole.activity.filter(({ details }) => details.kind === "quit");

          assert.lengthOf(quits, 15);
          assert.deepStrictEqual(
            quits.slice(0, 3).map(({ actor, details, place }) => ({ actor, details, place })),
            ["#a", "#b", "#c"].map((channel) => ({
              actor: "u1",
              details: {
                kind: "quit" as const,
                reason: { spans: [{ text: "*.net *.split" }], text: "*.net *.split" },
              },
              place: { _tag: "Channel" as const, key: channel, name: channel },
            }))
          );

          // Pages of two cut each three-row Entry, and still lose and repeat nothing.
          const paged: LoggedActivity[] = [];
          let after: ActivityCursor = { sequence: 0 };
          let page = yield* client.daemon.activity({ query: { after, limit: 2, network } });

          while (page.activity.length > 0) {
            paged.push(...page.activity);
            after = page.next;
            page = yield* client.daemon.activity({ query: { after, limit: 2, network } });
          }

          assert.deepStrictEqual(paged, whole.activity);
          assert.deepStrictEqual(
            page.next,
            after,
            "an empty page gives back where it was asked from"
          );

          // The cursor is one opaque value on the wire, such as `12.1`.
          const raw = yield* harness.raw.get(`/api/activity?network=${network}&limit=2&after=0`);

          const { next } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ next: Schema.String })
          )(yield* Effect.orDie(raw.json));

          const resumed = yield* harness.raw.get(`/api/activity?network=${network}&after=${next}`);

          assert.match(next, /^\d+\.\d+$/u);
          assert.strictEqual(resumed.status, 200);

          // A place on the Network, by any spelling the mapping allows (KNOW-3).
          const inB = yield* client.daemon.activity({
            query: {
              after: { sequence: 0 },
              limit: 1000,
              network,
              place: { _tag: "Channel", name: "#B" },
            },
          });

          assert.isNotEmpty(inB.activity);
          assert.isTrue(
            inB.activity.every(({ place }) => place._tag === "Channel" && place.key === "#b")
          );
          assert.lengthOf(
            inB.activity.filter(({ details }) => details.kind === "quit"),
            5
          );
        })
      )
    );

    it.live("API-3: refuses a place with no Network, and a cursor it never gave", () =>
      withSession((harness) =>
        Effect.gen(function* () {
          const noNetwork = yield* invalidRequest(
            yield* harness.raw.get("/api/activity?place=network")
          );

          assert.deepStrictEqual(noNetwork.issues[0]?.path, ["query", "place"]);

          for (const after of ["-1", "1.", "x", "1.2.3", "01"]) {
            const refused = yield* invalidRequest(
              yield* harness.raw.get(`/api/activity?after=${after}`)
            );

            assert.deepStrictEqual(refused.issues[0]?.path.slice(0, 2), ["query", "after"], after);
          }

          const badPlace = yield* invalidRequest(
            yield* harness.raw.get(`/api/activity?network=${network}&place=room:x`)
          );

          assert.deepStrictEqual(badPlace.issues[0]?.path, ["query", "place"]);
        })
      )
    );
  });

  describe("KNOW-3: a place keeps its history across a change of mapping", () => {
    it.live("finds rows keyed under ascii, then rfc1459, mid-Session and across a reconnect", () =>
      withSession((harness) =>
        Effect.gen(function* () {
          const { client, ircd } = harness;

          const inPlace = (name: string) =>
            Effect.map(
              client.daemon.activity({
                query: {
                  after: { sequence: 0 },
                  limit: 1000,
                  network,
                  place: { _tag: "Channel", name },
                },
              }),
              ({ activity }) =>
                activity.map(
                  ({ actor, place }) =>
                    `${actor ?? ""}@${place._tag === "Channel" ? place.key : ""}`
                )
            );

          // Under ascii, `#[a]` is its own key.
          yield* say(
            ircd,
            ":ircd 005 iirc CASEMAPPING=ascii :are supported",
            ":iirc!u@h JOIN #[a]",
            ":bob!b@h JOIN #[a]"
          );
          yield* recorded(harness, ":bob!b@h JOIN #[a]");

          // Mid-Session, rfc1459 folds `[` to `{`.
          yield* say(
            ircd,
            ":ircd 005 iirc CASEMAPPING=rfc1459 :are supported",
            ":carol!c@h JOIN #[A]"
          );
          yield* recorded(harness, ":carol!c@h JOIN #[A]");

          const expected = ["iirc@#[a]", "bob@#[a]", "carol@#{a}"];

          assert.deepStrictEqual(yield* inPlace("#[a]"), expected);
          assert.deepStrictEqual(yield* inPlace("#[A]"), expected, "any spelling");

          // Between Sessions no mapping is the Ircd's, and the history is still there.
          yield* ircd.hangUp;
          yield* eventually(statusOf(client, network), ({ phase }) => phase !== "session");
          assert.deepStrictEqual(yield* inPlace("#[a]"), expected);

          // A new Session, under the default rfc1459.
          yield* welcomed(harness);
          yield* say(ircd, ":iirc!u@h JOIN #[a]");
          yield* recorded(harness, ":iirc!u@h JOIN #[a]");

          assert.deepStrictEqual(yield* inPlace("#[a]"), [...expected, "iirc@#{a}"]);
          // A key a row gave finds the rows of its own mapping.
          assert.deepStrictEqual(yield* inPlace("#{a}"), ["carol@#{a}", "iirc@#{a}"]);
        })
      )
    );
  });

  describe("LOG-11: what a page of formatted text costs the main thread", () => {
    // A code before every character: about 4,300 spans in one Line, the most a Line holds.
    const dense = "\u0002x".repeat(4300);

    it.live(
      "bounds a page by its spans, so a hostile page is small to carry",
      () =>
        withSession(
          (harness) =>
            Effect.gen(function* () {
              const lines = Array.from(
                { length: 40 },
                (_, index) => `:bob!b@h PRIVMSG #adv :${index}${dense}`
              );

              yield* say(harness.ircd, ":iirc!u@h JOIN #adv");

              const joinedAt = yield* recorded(harness, ":iirc!u@h JOIN #adv");

              // More than one page of Entries, so the Log's head says when they are in.
              yield* say(harness.ircd, ...lines);
              yield* eventually(
                harness.client.daemon.status(),
                ({ head }) => (head ?? 0) >= joinedAt + lines.length
              );

              const Page = Schema.Array(
                Schema.Struct({ sequence: Schema.Int, spans: Schema.Array(Schema.Unknown) })
              );

              const pages: { readonly blocked: number; readonly spans: number }[] = [];
              let after = 0;

              for (;;) {
                const probe = lagProbe();
                const response = yield* harness.raw.get(`/api/messages?limit=1000&after=${after}`);
                const body = yield* Effect.orDie(response.text);
                const blocked = probe.stop();
                const page = yield* Schema.decodeEffect(Schema.fromJsonString(Page))(body);

                if (page.length === 0) {
                  break;
                }

                pages.push({
                  blocked,
                  spans: page.reduce((total, { spans }) => total + spans.length, 0),
                });
                after = page.at(-1)?.sequence ?? after;
              }

              const spansPerPage = Math.max(...pages.map(({ spans }) => spans));

              const blocked = pages
                .map(({ blocked: millis }) => millis)
                .toSorted((one, other) => one - other);

              const median = blocked[Math.floor(blocked.length / 2)] ?? 0;

              // At most what `pageBytes` holds of spans, past the one row that reaches it.
              assert.isAtMost(spansPerPage, pageBytes / spanBytes + dense.length);
              assert.strictEqual(
                pages.reduce((total, { spans }) => total + spans, 0),
                40 * 4301
              );
              // The longest the event loop stood still for one page, which held up appends.
              assert.isBelow(median, 20, "a page of the densest text a Network can send");
              yield* Effect.log(
                `${pages.length} pages, at most ${spansPerPage} spans, main thread blocked ${median.toFixed(1)} ms median, ${blocked.at(-1)?.toFixed(1) ?? "?"} ms at most`
              );
            }),
          "on its Worker"
        ),
      { timeout: 60_000 }
    );
  });

  describe("formatting (MSG-3)", () => {
    it.live("gives a Message's spans beside its raw text, and a reason's, as data", () =>
      withSession((harness) =>
        Effect.gen(function* () {
          yield* say(
            harness.ircd,
            ":iirc!u@h JOIN #fmt",
            ":bob!b@h PRIVMSG #fmt :\u0002bold\u000F <b>plain</b> \u001Ditalic",
            ":bob!b@h PART #fmt :\u000312,01blue on black",
            ":bob!b@h PRIVMSG iirc :\u0001DCC SEND \u0002file\u0002 1 2 3\u0001",
            ":ircd FAIL JOIN NO_SUCH #fmt :\u0002No\u0002 such"
          );
          yield* recorded(harness, ":ircd FAIL JOIN NO_SUCH #fmt :\u0002No\u0002 such");

          const [message] = yield* harness.client.daemon.messages(everything);

          assert.deepInclude(message, {
            spans: [
              { bold: true, text: "bold" },
              { text: " <b>plain</b> " },
              { italic: true, text: "italic" },
            ],
            text: "\u0002bold\u000F <b>plain</b> \u001Ditalic",
          });

          const { activity } = yield* harness.client.daemon.activity({
            query: {
              after: { sequence: 0 },
              limit: 1000,
              network,
              place: { _tag: "Channel", name: "#fmt" },
            },
          });

          assert.deepStrictEqual(activity.find(({ details }) => details.kind === "part")?.details, {
            kind: "part",
            reason: {
              spans: [
                {
                  background: { _tag: "Palette", index: 1 },
                  foreground: { _tag: "Palette", index: 12 },
                  text: "blue on black",
                },
              ],
              text: "\u000312,01blue on black",
            },
          });

          // An offer's arguments and a standard reply's words are text a Network chose too.
          const all = yield* harness.client.daemon.activity({
            query: { after: { sequence: 0 }, limit: 1000, network },
          });

          const details = all.activity.map((row) => row.details);

          assert.deepInclude(
            details.find(({ kind }) => kind === "dcc"),
            {
              args: {
                spans: [{ bold: true, text: "file" }, { text: " 1 2 3" }],
                text: "\u0002file\u0002 1 2 3",
              },
            }
          );
          assert.deepInclude(
            details.find(({ kind }) => kind === "reply"),
            {
              description: {
                spans: [{ bold: true, text: "No" }, { text: " such" }],
                text: "\u0002No\u0002 such",
              },
            }
          );
        })
      )
    );
  });
});
