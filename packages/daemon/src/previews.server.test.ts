import { createHash } from "node:crypto";

import { BunHttpServer, BunFileSystem } from "@effect/platform-bun";
import { MessagePreviews, PreviewItem, PreviewsEvent, TimelineList, UiInForce } from "@iirc/api";
import { Sha256 } from "@iirc/byte-store";
import { configured } from "@iirc/client/testing";
import { LinkRefused, LinkTimedOut, LinkTooLarge, LinkWrongType } from "@iirc/link-fetch";
import type { Answer, FakeLinkFetch } from "@iirc/link-fetch/testing";
import { makeFakeLinkFetch } from "@iirc/link-fetch/testing";
import type { PreviewCacheService } from "@iirc/preview-cache";
import { makeSqlitePreviewCache } from "@iirc/preview-cache-sqlite";
import type { JournalService } from "@iirc/runtime/journal";
import type { TimelineStoreService } from "@iirc/timeline-store";
import { Context, Duration, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ApiRoutes, Heartbeat } from "./handlers.ts";
import { gif, png } from "./testing/images.ts";
import {
  heard,
  layerWorld,
  makeKey,
  makeWorld,
  registerOnFloor,
  say,
  temporaryDirectory,
  unreachableEndpoint,
} from "./testing/world.ts";
import type { World } from "./testing/world.ts";

const floor = configured({ ircds: [{ host: "irc.test", port: 6667, tls: false }] });

/** What a test over a real server gets. */
interface Served {
  /** Sends a request with the key, unless `key` is null. */
  readonly request: (
    path: string,
    init?: RequestInit & { readonly key?: string | null }
  ) => Effect.Effect<Response>;
  /** Every fetch asked of the fake link fetch, in order. */
  readonly asked: FakeLinkFetch["asked"];
  readonly dataDir: string;
  readonly key: string;
  readonly world: World;
}

/** What a test brings to a server beyond what it answers. */
interface Setup {
  /** The link fetch to use instead of a fake answering the given answers. */
  readonly links?: FakeLinkFetch;
  /** The Preview cache to use instead of a fresh one in memory. */
  readonly previews?: PreviewCacheService;
  /** What a Daemon that was stopped left, for the next one to start on. */
  readonly left?: Left;
}

/** What outlives a Daemon: its data directory and key, its Journal, and its Timelines. */
interface Left {
  readonly dataDir: string;
  readonly key: string;
  readonly journal?: JournalService;
  readonly store?: TimelineStoreService;
}

/**
 * Serves the API over a real Bun server on an ephemeral loopback port, on the in-memory
 * ports, with the fake link fetch answering as told.
 * @param answers - What each link answers.
 * @param setup - What else it runs on.
 * @returns The server, which stops when the Scope closes.
 */
const serve = (answers: Readonly<Record<string, Answer>>, setup: Setup = {}) =>
  Effect.gen(function* () {
    const dataDir = setup.left?.dataDir ?? (yield* temporaryDirectory);
    const key = setup.left?.key ?? (yield* makeKey(dataDir));
    const fake = setup.links ?? (yield* makeFakeLinkFetch(answers));

    const world = yield* makeWorld(
      setup.left?.journal,
      setup.left?.store,
      fake.service,
      setup.previews
    );

    const server = HttpRouter.serve(ApiRoutes, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        BunHttpServer.layer({ gracefulShutdownTimeout: 100, hostname: "127.0.0.1", port: 0 })
      ),
      // A burst wide enough that no Line waits on the real clock's pacing.
      Layer.provide(layerWorld(world, dataDir, { burst: 100, interval: 2000 })),
      Layer.provide(Layer.succeed(Heartbeat, Duration.millis(50)))
    );

    const context = yield* Layer.build(server);
    const { address } = Context.get(context, HttpServer.HttpServer);

    const base =
      address._tag === "UnixPathAddress" ? "http://invalid" : `http://127.0.0.1:${address.port}`;

    const served: Served = {
      asked: fake.asked,
      dataDir,
      key,
      request: (path, init = {}) =>
        Effect.promise(async () => {
          const { key: presented = key, ...rest } = init;
          const headers = new Headers(rest.headers);

          if (presented !== null) {
            headers.set("authorization", `Bearer ${presented}`);
          }

          return await fetch(`${base}${path}`, { ...rest, headers });
        }),
      world,
    };

    return served;
  });

const run = async <A, E>(
  answers: Readonly<Record<string, Answer>>,
  test: (served: Served) => Effect.Effect<A, E, Scope.Scope>
) => await Effect.runPromise(Effect.scoped(serve(answers).pipe(Effect.flatMap(test))));

/**
 * Runs a test on the TestClock, which only the test moves. The server's own timers wait for
 * it, so what a test waits for on the real clock is wrapped in {@link live}.
 * @param test - The test.
 * @returns What the test returned.
 */
const runClocked = async <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  await Effect.runPromise(Effect.scoped(test).pipe(Effect.provide(TestClock.layer())));

/** Waits on the real clock, within a test on the TestClock. */
const live = TestClock.withLive;

const bodyOf = (response: Response) => Effect.promise(async () => await response.text());

const json = (value: Schema.Json): RequestInit => ({
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
});

const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(TimelineList));

const decodePreviews = Schema.decodeUnknownSync(Schema.fromJsonString(MessagePreviews));

const decodeItem = Schema.decodeUnknownSync(Schema.fromJsonString(PreviewItem));

const decodeEvent = Schema.decodeUnknownSync(PreviewsEvent);

const decodeError = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String }))
);

/** A window's items, with each position as the cursor the wire gave. */
const decodeWindow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          content: Schema.Struct({ _tag: Schema.String, text: Schema.optionalKey(Schema.String) }),
          position: Schema.String,
        })
      ),
    })
  )
);

/**
 * Sets `ui.previews`.
 * @param served - The server.
 * @param value - Its value.
 * @returns An Effect that sets it.
 */
const setPreviews = (served: Served, value: string) =>
  Effect.gen(function* () {
    const response = yield* served.request("/api/ui/previews", {
      method: "PUT",
      ...json({ value }),
    });

    expect(response.status).toBe(200);
  });

/** Where a peer speaks to Self: in the Channel, or in a Direct Message. */
type Where = "#iirc" | "iirc";

/**
 * Configures `libera`, registers it on the floor, joins `#iirc`, and has a peer say each
 * text in each place, a Channel or a Direct Message to Self.
 * @param served - The server.
 * @param texts - What the peer says.
 * @param where - Where it says them.
 * @returns An Effect that does it.
 */
const talk = (served: Served, texts: readonly string[], where: readonly Where[] = ["#iirc"]) =>
  Effect.gen(function* () {
    const configured = yield* served.request("/api/networks/libera", {
      method: "PUT",
      ...json(floor),
    });

    expect(configured.status).toBe(200);
    const call = yield* registerOnFloor(served.world.memory);

    yield* say(call, ":iirc!u@h JOIN #iirc");

    for (const text of texts) {
      for (const place of where) {
        yield* say(call, `:peer!u@h PRIVMSG ${place} :${text}`);
      }
    }
  });

/** A Message's Timeline and place, as a window gave them. */
interface Place {
  readonly timeline: string;
  readonly position: string;
  readonly text: string;
}

/** Not yet as many Messages as were said. */
class NotYet extends Schema.TaggedError<NotYet, { readonly brand: unique symbol }>()(
  "NotYet",
  {}
) {}

/**
 * The Messages of the Timeline of a kind, once there are `count` of them.
 * @param served - The server.
 * @param count - How many Messages to wait for.
 * @param kind - The Timeline's kind.
 * @returns Each Message's place, in order.
 */
const messages = (served: Served, count: number, kind: "Channel" | "Direct" = "Channel") =>
  Effect.gen(function* () {
    const listed = decodeList(
      yield* bodyOf(yield* served.request("/api/networks/libera/timelines"))
    );

    const timeline = listed.timelines.find((one) => one.kind === kind);

    if (timeline === undefined) {
      return yield* new NotYet();
    }

    const window = decodeWindow(
      yield* bodyOf(yield* served.request(`/api/timelines/${timeline.id}?limit=50`))
    );

    const found = window.items.flatMap((item): Place[] =>
      item.content._tag === "Message"
        ? [{ position: item.position, text: item.content.text ?? "", timeline: timeline.id }]
        : []
    );

    return found.length < count ? yield* new NotYet() : found;
  }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"), Effect.orDie);

/**
 * Our own Message, once the Ircd has confirmed it with text of its own.
 * @param served - The server.
 * @returns Its place.
 */
const confirmed = (served: Served) =>
  Effect.gen(function* () {
    const places = yield* messages(served, 1);
    const [place] = places;

    const window = yield* bodyOf(
      yield* served.request(`/api/timelines/${place?.timeline}?limit=50`)
    );

    return window.includes('"Confirmed"') ? places : yield* new NotYet();
  }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"), Effect.orDie);

/**
 * Asks for a Message's Previews.
 * @param served - The server.
 * @param place - The Message's place.
 * @param init - Headers and the key, to ask otherwise than with the key.
 * @returns The response.
 */
const ask = (
  served: Served,
  place: Pick<Place, "timeline" | "position">,
  init: RequestInit & { readonly key?: string | null } = {}
) =>
  served.request(`/api/timelines/${place.timeline}/previews`, {
    method: "POST",
    ...json({ position: place.position }),
    ...init,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });

/**
 * A Message's Previews, once none is pending.
 * @param served - The server.
 * @param place - The Message's place.
 * @returns Its items.
 */
const settled = (served: Served, place: Place) =>
  Effect.gen(function* () {
    const { previews } = decodePreviews(yield* bodyOf(yield* ask(served, place)));

    return previews.some((one) => one.state._tag === "Pending") ? yield* new NotYet() : previews;
  }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"), Effect.orDie);

const page = (head: string) => ({ body: `<html><head>${head}</head><body>`, type: "text/html" });

const cats = page(
  '<title>Cats</title><meta property="og:site_name" content="Cat News"><meta name="description" content="All about cats.">'
);

const stateOf = (item: PreviewItem | undefined) => item?.state;

/**
 * The text Preview of a link to media itself.
 * @param link - The link.
 * @param kind - Its kind.
 * @param type - Its media type.
 * @returns The state.
 */
const media = (link: string, kind: string, type: string) => ({
  _tag: "Ready",
  preview: {
    description: null,
    image: null,
    kind,
    link,
    site: new URL(link).host,
    title: null,
    type,
  },
});

describe("Previews over a real server", () => {
  it("answers Previews off while ui.previews is off, and fetches nothing", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* talk(served, ["see https://cats.example/"]);
        const [message] = yield* messages(served, 1);
        const answer = yield* ask(served, message ?? { position: "", timeline: "" });

        return {
          asked: yield* served.asked,
          error: decodeError(yield* bodyOf(answer))._tag,
          status: answer.status,
        };
      })
    );

    expect(result).toStrictEqual({ asked: [], error: "PreviewsOff", status: 409 });
  });

  it("gives a page's Preview under links only, pending first, fetched as a page", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["see https://cats.example/ now"]);
        const [message] = yield* messages(served, 1);
        const place = message ?? { position: "", text: "", timeline: "" };
        const first = decodePreviews(yield* bodyOf(yield* ask(served, place))).previews;
        const after = yield* settled(served, place);

        return { after, asked: yield* served.asked, first: first.map(stateOf) };
      })
    );

    expect(result).toStrictEqual({
      after: [
        {
          id: result.after[0]?.id,
          link: "https://cats.example/",
          state: {
            _tag: "Ready",
            preview: {
              description: "All about cats.",
              image: null,
              kind: "page",
              link: "https://cats.example/",
              site: "Cat News",
              title: "Cats",
              type: null,
            },
          },
        },
      ],
      asked: [{ link: "https://cats.example/", purpose: { kind: "page" } }],
      first: [{ _tag: "Pending" }],
    });
    expect(result.after[0]?.id).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("previews the links of the echo's text, not ours, for a Message Self said and the Ircd confirmed", async () => {
    const result = await run(
      { "https://cats.example/": cats, "https://ours.example/": cats },
      (served) =>
        Effect.gen(function* () {
          yield* setPreviews(served, "links only");

          const configured = yield* served.request("/api/networks/libera", {
            method: "PUT",
            ...json(floor),
          });

          expect(configured.status).toBe(200);
          const call = yield* served.world.memory.ircd.accept;

          yield* call.open;
          yield* heard(call);
          yield* heard(call);
          yield* heard(call);
          yield* say(call, ":irc.test CAP * LS :batch echo-message labeled-response");
          yield* heard(call);
          yield* say(call, ":irc.test CAP * ACK :batch echo-message labeled-response");
          yield* heard(call);
          yield* say(call, ":irc.test 001 iirc :Welcome");
          yield* say(call, ":iirc!u@h JOIN #iirc");

          // The Client asks a Channel's modes once it has stepped our JOIN, so the welcome
          // before it is stepped too, and the say is not refused as Offline.
          expect(yield* heard(call)).toBe("MODE #iirc");

          const said = yield* served.request("/api/networks/libera/say", {
            method: "POST",
            ...json({ kind: "Privmsg", target: "#iirc", text: "see https://ours.example/" }),
          });

          expect([said.status, decodeError(yield* bodyOf(said))._tag]).toStrictEqual([200, "Said"]);
          const sent = yield* heard(call);

          expect(sent).toMatch(/^@label=\S+ PRIVMSG #iirc :see https:\/\/ours\.example\/$/u);
          const [tags = ""] = sent.split(" ");

          yield* say(call, `${tags} :iirc!u@h PRIVMSG #iirc :see https://cats.example/`);

          const [place] = yield* confirmed(served);

          return (yield* settled(served, place ?? { position: "", text: "", timeline: "" })).map(
            (one) => one.link
          );
        })
    );

    expect(result).toStrictEqual(["https://cats.example/"]);
  });

  it("gives a link to media reached through a redirect as a Preview of the final link", async () => {
    const result = await run(
      {
        "https://short.example/p": new LinkWrongType({
          link: "https://cdn.example/cat.png",
          type: "image/png",
        }),
      },
      (served) =>
        Effect.gen(function* () {
          yield* setPreviews(served, "links only");
          yield* talk(served, ["https://short.example/p"]);
          const [place] = yield* messages(served, 1);

          return (yield* settled(served, place ?? { position: "", text: "", timeline: "" })).map(
            (one) => [one.link, one.state]
          );
        })
    );

    expect(result).toStrictEqual([
      ["https://short.example/p", media("https://cdn.example/cat.png", "image", "image/png")],
    ]);
  });

  it("gives three items for a Message of four links, in its order, each fetched once", async () => {
    const links = [
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
    ];

    const result = await run(
      Object.fromEntries(links.map((link, index) => [link, page(`<title>${index}</title>`)])),
      (served) =>
        Effect.gen(function* () {
          yield* setPreviews(served, "on");
          yield* talk(served, [links.join(" ")]);
          const [message] = yield* messages(served, 1);
          const items = yield* settled(served, message ?? { position: "", text: "", timeline: "" });

          return {
            asked: (yield* served.asked).map((one) => one.link),
            items: items.map((one) => [
              one.link,
              one.state._tag === "Ready" ? one.state.preview.title : null,
            ]),
          };
        })
    );

    expect(result).toStrictEqual({
      asked: links.slice(0, 3),
      items: [
        ["https://a.example/", "0"],
        ["https://b.example/", "1"],
        ["https://c.example/", "2"],
      ],
    });
  });

  it("fetches one link in two Messages once, under one id, and a Message with no link gives none", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, [
          "https://cats.example/",
          "again https://cats.example/#top",
          "no link",
        ]);
        const [one, two, none] = yield* messages(served, 3);
        const first = yield* settled(served, one ?? { position: "", text: "", timeline: "" });
        const second = yield* settled(served, two ?? { position: "", text: "", timeline: "" });
        const third = yield* settled(served, none ?? { position: "", text: "", timeline: "" });

        return {
          asked: (yield* served.asked).length,
          links: [first[0]?.link, second[0]?.link],
          none: third,
          sameId: first[0]?.id === second[0]?.id,
          sameState: JSON.stringify(first[0]?.state) === JSON.stringify(second[0]?.state),
        };
      })
    );

    expect(result).toStrictEqual({
      asked: 1,
      links: ["https://cats.example/", "https://cats.example/#top"],
      none: [],
      sameId: true,
      sameState: true,
    });
  });

  it("shows each failure as its reason, and a link to media as a text Preview from its type", async () => {
    const answers = {
      "https://audio.example/": new LinkWrongType({
        link: "https://audio.example/",
        type: "audio/ogg",
      }),
      "https://bare.example/": page("<style></style>"),
      "https://big.example/": new LinkTooLarge({ limit: 1024 }),
      "https://image.example/cat.png": { body: "not read", type: "image/png" },
      "https://plain.example/": new LinkWrongType({
        link: "https://plain.example/",
        type: "text/plain",
      }),
      "https://private.example/": new LinkRefused({ reason: "a private address" }),
      "https://slow.example/": new LinkTimedOut(),
      "https://video.example/": new LinkWrongType({
        link: "https://video.example/",
        type: "video/mp4",
      }),
    } satisfies Record<string, Answer>;

    const texts = [
      "https://private.example/ https://gone.example/ https://slow.example/",
      "https://big.example/ https://bare.example/ https://plain.example/",
      "https://image.example/cat.png https://video.example/ https://audio.example/",
    ];

    const result = await run(answers, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, texts);
        const places = yield* messages(served, 3);
        const items: PreviewItem[] = [];

        for (const place of places) {
          items.push(...(yield* settled(served, place)));
        }

        return items.map((one) => [one.link, one.state]);
      })
    );

    expect(result).toStrictEqual([
      ["https://private.example/", { _tag: "Failed", reason: "Refused" }],
      ["https://gone.example/", { _tag: "Failed", reason: "Unreachable" }],
      ["https://slow.example/", { _tag: "Failed", reason: "TimedOut" }],
      ["https://big.example/", { _tag: "Failed", reason: "TooLarge" }],
      ["https://bare.example/", { _tag: "Failed", reason: "NothingToShow" }],
      ["https://plain.example/", { _tag: "Failed", reason: "NothingToShow" }],
      [
        "https://image.example/cat.png",
        media("https://image.example/cat.png", "image", "image/png"),
      ],
      ["https://video.example/", media("https://video.example/", "video", "video/mp4")],
      ["https://audio.example/", media("https://audio.example/", "audio", "audio/ogg")],
    ]);
  });

  it("streams each change of a Preview's state, pending then ready, to a Frontend that did not ask", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["https://cats.example/"]);
        const [message] = yield* messages(served, 1);
        const following = yield* served.request("/api/previews/changes");

        // The stream is followed before the ask, which its first heartbeat says.
        const body: ReadableStream<Uint8Array> | null = following.body;
        const reader = body?.getReader();
        const decoder = new TextDecoder();
        let text = "";

        const until = (done: (text: string) => boolean) =>
          Effect.promise(async () => {
            while (!done(text)) {
              // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
              const chunk = await reader?.read();

              if (chunk === undefined || chunk.done) {
                return;
              }

              text += decoder.decode(chunk.value, { stream: true });
            }
          });

        yield* until((read) => read.includes("event: heartbeat"));
        yield* ask(served, message ?? { position: "", timeline: "" });
        yield* until((read) => read.includes('"Ready"'));
        yield* Effect.promise(async () => await reader?.cancel());

        return text
          .split("\n\n")
          .filter((block) => block.startsWith("event: changed"))
          .map((block) => {
            const fields = new Map(
              block
                .split("\n")
                .map((line) => [
                  line.slice(0, line.indexOf(":")),
                  line.slice(line.indexOf(":") + 2),
                ])
            );

            const event = decodeEvent({ data: fields.get("data"), event: fields.get("event") });

            return event.event === "changed" ? [event.data.link, event.data.state._tag] : [];
          });
      })
    );

    expect(result).toStrictEqual([
      ["https://cats.example/", "Pending"],
      ["https://cats.example/", "Ready"],
    ]);
  });

  it("refuses an unknown Timeline and a place where no Message stands, with 404", async () => {
    const result = await run({}, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["hello"]);
        const [message] = yield* messages(served, 1);
        const place = message ?? { position: "", timeline: "" };
        const before = place.position.replace(/-[0-9a-f]{8}$/u, "-0000ffff");
        const nowhere = { ...place, timeline: "00000000000999-00000000-00000000" };

        return yield* Effect.forEach(
          [ask(served, { ...place, position: before }), ask(served, nowhere)],
          (asked) =>
            Effect.gen(function* () {
              const answer = yield* asked;

              return [answer.status, decodeError(yield* bodyOf(answer))._tag];
            })
        );
      })
    );

    expect(result).toStrictEqual([
      [404, "UnknownMessage"],
      [404, "UnknownTimeline"],
    ]);
  });

  it("waits for a press in a Direct Message, and fetches nothing", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "on");
        yield* talk(served, ["https://cats.example/"], ["iirc"]);
        const [message] = yield* messages(served, 1, "Direct");
        const items = yield* settled(served, message ?? { position: "", text: "", timeline: "" });

        return { asked: yield* served.asked, states: items.map(stateOf) };
      })
    );

    expect(result).toStrictEqual({ asked: [], states: [{ _tag: "WaitingForPress" }] });
  });

  it("takes an ask by a sign-in's cookie only from the Daemon's own origin", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["https://cats.example/"]);
        const [message] = yield* messages(served, 1);
        const place = message ?? { position: "", timeline: "" };

        const signedIn = yield* served.request("/api/sign-in", {
          ...json({ key: served.key }),
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          key: null,
          method: "POST",
        });

        const token = /^iirc_sign_in=(?<token>[^;]+)/u.exec(
          signedIn.headers.getSetCookie()[0] ?? ""
        )?.groups?.token;

        const asBrowser = (site: string) =>
          ask(served, place, {
            headers: { cookie: `iirc_sign_in=${token ?? ""}`, "sec-fetch-site": site },
            key: null,
          });

        const crossSite = yield* asBrowser("cross-site");
        const refused = [crossSite.status, decodeError(yield* bodyOf(crossSite))._tag];
        const fetchedAfterRefusal = (yield* served.asked).length;
        const sameOrigin = yield* asBrowser("same-origin");

        return {
          fetchedAfterRefusal,
          refused,
          sameOrigin: sameOrigin.status,
        };
      })
    );

    expect(result).toStrictEqual({
      fetchedAfterRefusal: 0,
      refused: [403, "CrossOrigin"],
      sameOrigin: 200,
    });
  });
});

const OEMBED = "https://media.example/oembed?url=https%3A%2F%2Fpage.example%2F";

/**
 * A page whose head names an oEmbed address, besides `head`.
 * @param head - The rest of its head.
 * @param address - The oEmbed address it names.
 * @returns The page's answer.
 */
const withOembed = (head: string, address = OEMBED) =>
  page(`${head}<link rel="alternate" type="application/json+oembed" href="${address}">`);

const answer = (value: Schema.Json) => ({
  body: JSON.stringify(value),
  type: "application/json",
});

/**
 * Previews the one link in a Message under `links only`.
 * @param answers - What each link answers.
 * @param link - The link.
 * @returns Its state, and every fetch asked.
 */
const previewed = async (answers: Readonly<Record<string, Answer>>, link: string) =>
  await run(answers, (served) =>
    Effect.gen(function* () {
      yield* setPreviews(served, "links only");
      yield* talk(served, [`see ${link}`]);
      const [place] = yield* messages(served, 1);
      const [item] = yield* settled(served, place ?? { position: "", text: "", timeline: "" });

      return { asked: yield* served.asked, state: item?.state };
    })
  );

const asPage = { kind: "page" } as const;
const asOembed = { kind: "oembed" } as const;

const ready = (preview: Partial<Record<string, string | null>>) => ({
  _tag: "Ready",
  preview: {
    description: null,
    image: null,
    kind: "page",
    link: "https://page.example/",
    site: "page.example",
    title: null,
    type: null,
    ...preview,
  },
});

describe("a page's oEmbed over a real server", () => {
  it("fills only the gaps the page's own tags left, fetching the address it names and never the thumbnail", async () => {
    const result = await previewed(
      {
        [OEMBED]: answer({
          author_name: "Author",
          thumbnail_height: 90,
          thumbnail_url: "https://cdn.example/t.jpg",
          thumbnail_width: 120,
          title: "oEmbed title",
          type: "video",
        }),
        "https://page.example/": withOembed(
          '<title>Tag title</title><meta name="description" content="Tag description">'
        ),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual(
      ready({ description: "Tag description", site: "Author", title: "Tag title" })
    );

    expect(result.asked).toStrictEqual([
      { link: "https://page.example/", purpose: asPage },
      { link: OEMBED, purpose: asOembed },
    ]);
  });

  it("lets the page's tags win where they have the field", async () => {
    const result = await previewed(
      {
        [OEMBED]: answer({ author_name: "Author", title: "oEmbed title" }),
        "https://page.example/": withOembed(
          '<meta property="og:title" content="Tag title"><meta property="og:site_name" content="Tag Site">'
        ),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual(ready({ site: "Tag Site", title: "Tag title" }));
  });

  it("shows a page with only an oEmbed link as the oEmbed title, with its author as the site", async () => {
    const result = await previewed(
      {
        [OEMBED]: answer({ author_name: "Some Author", title: "From oEmbed", type: "rich" }),
        "https://page.example/": withOembed(""),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual(ready({ site: "Some Author", title: "From oEmbed" }));
  });

  it("uses nothing from a rich answer's html", async () => {
    const result = await previewed(
      {
        [OEMBED]: answer({
          html: '<script>alert("x")</script><b>Hijacked</b>',
          type: "rich",
        }),
        "https://page.example/": withOembed("<title>Tag title</title>"),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual(ready({ title: "Tag title" }));
    expect(JSON.stringify(result.state)).not.toMatch(/<script|alert|Hijacked/u);
  });

  it("leaves a page with only an oEmbed link and an html-only answer with nothing to show", async () => {
    const result = await previewed(
      {
        [OEMBED]: answer({ html: "<b>Hijacked</b>", type: "rich" }),
        "https://page.example/": withOembed(""),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual({ _tag: "Failed", reason: "NothingToShow" });
  });

  it("is unaffected when the guard refuses the oEmbed address as a private host", async () => {
    const address = "http://127.0.0.1/oembed";

    const result = await previewed(
      {
        [address]: new LinkRefused({ reason: "a private address" }),
        "https://page.example/": withOembed("<title>Tag title</title>", address),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual(ready({ title: "Tag title" }));

    expect(result.asked).toStrictEqual([
      { link: "https://page.example/", purpose: asPage },
      { link: address, purpose: asOembed },
    ]);
  });

  it("is unaffected when the oEmbed answer is too large", async () => {
    const result = await previewed(
      {
        [OEMBED]: new LinkTooLarge({ limit: 64 * 1024 }),
        "https://page.example/": withOembed("<title>Tag title</title>"),
      },
      "https://page.example/"
    );

    expect(result.state).toStrictEqual(ready({ title: "Tag title" }));
  });

  it("is unaffected by an oEmbed answer that is not JSON, not a success, or not recorded", async () => {
    const link = "https://page.example/";

    const recorded: Answer[] = [
      { body: "<html>", type: "application/json" },
      { ...answer({ title: "No" }), status: 404 },
      { ...answer({ title: "No" }), status: 301 },
      { body: "[1,2]", type: "application/json" },
    ];

    const states = await Promise.all([
      previewed({ "https://page.example/": withOembed("<title>Tag title</title>") }, link),
      ...recorded.map(
        async (one) =>
          await previewed(
            { [OEMBED]: one, "https://page.example/": withOembed("<title>Tag title</title>") },
            link
          )
      ),
    ]);

    for (const result of states) {
      expect(result.state).toStrictEqual(ready({ title: "Tag title" }));
    }
  });

  it("fetches no oEmbed when the page names none", async () => {
    const result = await previewed({ "https://page.example/": cats }, "https://page.example/");

    expect(result.asked).toStrictEqual([{ link: "https://page.example/", purpose: asPage }]);
  });
});

/**
 * A link fetch whose links answer one way until it is turned, and the other way after, with
 * what both were asked, in order.
 * @param before - What each link answers at first.
 * @param after - What each link answers once turned.
 * @returns The link fetch, and what turns it.
 */
const turning = (
  before: Readonly<Record<string, Answer>>,
  after: Readonly<Record<string, Answer>>
) =>
  Effect.gen(function* () {
    const first = yield* makeFakeLinkFetch(before);
    const second = yield* makeFakeLinkFetch(after);
    const turned = yield* Ref.make(false);

    const links: FakeLinkFetch = {
      asked: Effect.map(Effect.all([first.asked, second.asked]), ([a, b]) => [...a, ...b]),
      release: (link) => Effect.andThen(first.release(link), second.release(link)),
      service: {
        fetch: (link, purpose) =>
          Effect.flatMap(Ref.get(turned), (now) =>
            (now ? second : first).service.fetch(link, purpose)
          ),
      },
    };

    return { links, turn: Ref.set(turned, true) };
  });

const dogs = page(
  '<title>Dogs</title><meta property="og:site_name" content="Dog News"><meta name="description" content="All about dogs.">'
);

/**
 * Follows the changes stream, and reads it as it comes.
 * @param served - The server.
 * @returns What it has read so far, and what waits until a read satisfies a test.
 */
const follow = (served: Served) =>
  Effect.gen(function* () {
    // The heartbeat is on the TestClock, so it is moved, a beat at a time, until one says
    // the stream is followed. The response may wait for it, too.
    const beat = Effect.gen(function* () {
      yield* TestClock.adjust(50);
      yield* Effect.promise(async () => {
        await Bun.sleep(10);
      });
    }).pipe(Effect.forever);

    const following = yield* served
      .request("/api/previews/changes")
      .pipe((request) => Effect.raceFirst(beat, request));

    const body: ReadableStream<Uint8Array> | null = following.body;
    const reader = body?.getReader();
    const decoder = new TextDecoder();
    let text = "";

    const until = (done: (read: string) => boolean) =>
      Effect.promise(async () => {
        while (!done(text)) {
          // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
          const chunk = await reader?.read();

          if (chunk === undefined || chunk.done) {
            return;
          }

          text += decoder.decode(chunk.value, { stream: true });
        }
      }).pipe(Effect.timeout("5 seconds"), Effect.orDie);

    yield* Effect.raceFirst(
      beat,
      until((read) => read.includes("event: heartbeat"))
    );

    return {
      stop: Effect.promise(async () => await reader?.cancel()),
      text: () => text,
      until: (done: (read: string) => boolean) => live(until(done)),
    };
  });

/**
 * What a Message's Previews show: each title, or the state of one that has none.
 * @param items - The items.
 * @returns What each shows.
 */
const titles = (items: readonly PreviewItem[]) =>
  items.map((one) => (one.state._tag === "Ready" ? one.state.preview.title : one.state._tag));

const hour = 60 * 60 * 1000;
const day = 24 * hour;

/**
 * Says a Message with one link, with Previews on.
 * @param served - The server.
 * @returns Its place.
 */
const said = (served: Served) =>
  Effect.gen(function* () {
    yield* setPreviews(served, "links only");
    yield* talk(served, ["see https://cats.example/"]);
    const [message] = yield* live(messages(served, 1));

    return message ?? { position: "", text: "", timeline: "" };
  });

/**
 * A Message's Previews, as they are now.
 * @param served - The server.
 * @param place - The Message's place.
 * @returns Its items.
 */
const asking = (served: Served, place: Place) =>
  Effect.gen(function* () {
    return decodePreviews(yield* bodyOf(yield* ask(served, place))).previews;
  });

/**
 * Waits until the link fetch has been asked as many times as given.
 * @param served - The server.
 * @param count - How many.
 * @returns An Effect that ends when it has.
 */
const fetches = (served: Served, count: number) =>
  live(
    Effect.gen(function* () {
      return (yield* served.asked).length === count ? count : yield* new NotYet();
    }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"), Effect.orDie)
  );

describe("the Preview cache over a real server", () => {
  it("serves a Preview over a day old as it was and fetches it again, the stream carrying the new one", async () => {
    const result = await runClocked(
      Effect.gen(function* () {
        const { links, turn } = yield* turning(
          { "https://cats.example/": cats },
          {
            "https://cats.example/": dogs,
          }
        );

        const served = yield* serve({}, { links });
        const place = yield* said(served);

        yield* TestClock.setTime(day);
        yield* live(settled(served, place));

        // The clock moves before the stream is followed, as each heartbeat is a wake-up.
        yield* turn;
        yield* TestClock.adjust(day + 1);
        const stream = yield* follow(served);
        const old = yield* asking(served, place);

        yield* stream.until((read) => read.includes("Dog News"));
        yield* stream.stop;
        yield* fetches(served, 2);

        return {
          after: titles(yield* live(settled(served, place))),
          carried: stream.text().includes("Dog News"),
          old: titles(old),
        };
      })
    );

    expect(result).toStrictEqual({ after: ["Dogs"], carried: true, old: ["Cats"] });
  });

  it("serves a Preview under a day old without fetching it again", async () => {
    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve({ "https://cats.example/": cats });
        const place = yield* said(served);

        yield* live(settled(served, place));
        yield* TestClock.adjust(day);
        const again = yield* asking(served, place);

        return { again: titles(again), asked: (yield* served.asked).length };
      })
    );

    expect(result).toStrictEqual({ again: ["Cats"], asked: 1 });
  });

  it("serves a failure for an hour with no fetch, then fetches it again on the next ask", async () => {
    const result = await runClocked(
      Effect.gen(function* () {
        const { links, turn } = yield* turning(
          { "https://cats.example/": new LinkRefused({ reason: "private" }) },
          { "https://cats.example/": cats }
        );

        const served = yield* serve({}, { links });
        const place = yield* said(served);

        yield* live(settled(served, place));
        yield* turn;
        yield* TestClock.adjust(hour - 1);
        const within = titles(yield* asking(served, place));
        const askedWithin = (yield* served.asked).length;

        yield* TestClock.adjust(1);
        const next = titles(yield* asking(served, place));

        return {
          askedWithin,
          later: titles(yield* live(settled(served, place))),
          next,
          within,
        };
      })
    );

    expect(result).toStrictEqual({
      askedWithin: 1,
      later: ["Cats"],
      next: ["Pending"],
      within: ["Failed"],
    });
  });

  it("moves when a Preview was last shown with each ask", async () => {
    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve({ "https://cats.example/": cats });
        const place = yield* said(served);

        yield* TestClock.setTime(1000);
        yield* live(settled(served, place));
        const first = yield* served.world.previews.get("https://cats.example/");

        yield* TestClock.adjust(5000);
        yield* asking(served, place);
        const second = yield* served.world.previews.get("https://cats.example/");

        const read = (kept: typeof first) =>
          Option.isSome(kept) ? [kept.value.fetched, kept.value.shown] : [];

        return { first: read(first), second: read(second) };
      })
    );

    expect(result).toStrictEqual({ first: [1000, 1000], second: [1000, 6000] });
  });

  it("keeps Previews across a restart, fetching nothing again", async () => {
    const result = await runClocked(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const file = `${dataDir}/previews.sqlite`;
        const answers = { "https://cats.example/": cats };

        // The cache is opened, and closed, with each Daemon, on the same file.
        const opened = makeSqlitePreviewCache(file).pipe(
          Effect.provide(BunFileSystem.layer),
          Effect.orDie
        );

        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const served = yield* serve(answers, {
              left: { dataDir, key },
              previews: yield* opened,
            });

            const place = yield* said(served);
            const items = yield* live(settled(served, place));

            return {
              asked: (yield* served.asked).length,
              items,
              left: { dataDir, journal: served.world.journal, key, store: served.world.store },
              place,
            };
          })
        );

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const served = yield* serve(answers, {
              left: before.left,
              previews: yield* opened,
            });

            const items = yield* asking(served, before.place);

            return {
              again: items,
              asked: (yield* served.asked).length,
              before: before.items,
              firstAsked: before.asked,
            };
          })
        );
      })
    );

    expect(result.firstAsked).toBe(1);
    expect(result.asked).toBe(0);
    expect(titles(result.again)).toStrictEqual(["Cats"]);
    expect(result.again).toStrictEqual(result.before);
  });
});

/**
 * Sends a request that must be answered with a status.
 * @param answer - The request.
 * @param status - The status.
 * @returns An Effect that dies otherwise.
 */
const expecting = (answer: Effect.Effect<Response>, status: number) =>
  Effect.gen(function* () {
    const response = yield* answer;

    if (response.status === status) {
      return response;
    }

    const text = yield* bodyOf(response);

    return yield* Effect.die(new Error(`answered ${response.status}: ${text}`));
  });

/**
 * Sets an option.
 * @param served - The server.
 * @param option - Its name.
 * @param value - Its value.
 * @returns An Effect that sets it.
 */
const setOption = (served: Served, option: string, value: Schema.Json) =>
  expecting(served.request(`/api/options/${option}`, { method: "PUT", ...json({ value }) }), 200);

/**
 * Sets up a bucket: its keys, held, and where it is.
 * @param served - The server.
 * @param endpoint - Where it is, which the world's byte store reaches unless it is the
 * unreachable endpoint.
 * @returns An Effect that sets it up.
 */
const setBucket = (served: Served, endpoint = "http://bucket.test") =>
  Effect.gen(function* () {
    const keys = { "bucket-key-id": "AKIA-test", "bucket-secret": "s3cr3t" };

    for (const [name, value] of Object.entries(keys)) {
      yield* expecting(
        served.request(`/api/credentials/${name}`, { method: "PUT", ...json({ value }) }),
        204
      );
    }

    yield* setOption(served, "store.s3.endpoint", endpoint);
    yield* setOption(served, "store.s3.bucket", "previews");
    yield* setOption(served, "store.s3.region", "us-east-1");
    yield* setOption(served, "store.s3.accessKeyId", "bucket-key-id");
    yield* setOption(served, "store.s3.secretAccessKey", "bucket-secret");
  });

const decodeUploaded = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ hash: Schema.String, id: Schema.String }))
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const CAT = "https://cat.example/";
const CAT_IMAGE = "https://cdn.example/cat.png";

const catPage = page(`<title>Cat</title><meta property="og:image" content="${CAT_IMAGE}">`);

const svg = new TextEncoder().encode(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><style>rect{fill:red}</style><rect width="2" height="2"/></svg>'
);

/**
 * Previews the one link in a Message, under a mode, and gives its state, and every fetch.
 * @param served - The server.
 * @param link - The link.
 * @param mode - `on` or `links only`.
 * @returns Its state, and every fetch asked.
 */
const previewedOn = (served: Served, link: string, mode = "on") =>
  Effect.gen(function* () {
    yield* setPreviews(served, mode);
    yield* talk(served, [`see ${link}`]);
    const [place] = yield* messages(served, 1);
    const [item] = yield* settled(served, place ?? { position: "", text: "", timeline: "" });

    return { asked: yield* served.asked, state: item?.state };
  });

/**
 * The image a Ready state's Preview holds.
 * @param state - The state.
 * @returns The image, or null.
 */
const imageOf = (state: PreviewItem["state"] | undefined) =>
  state?._tag === "Ready" ? state.preview.image : undefined;

/**
 * A response's headers, as a plain record.
 * @param response - The response.
 * @returns Its headers.
 */
const headersOf = (response: Response) => Object.fromEntries(response.headers.entries());

const bytesOf = (response: Response) =>
  Effect.promise(async () => new Uint8Array(await response.arrayBuffer()));

const asPageAgain = { kind: "page" } as const;
const asImage = { kind: "image" } as const;

describe("a Preview's image over a real server", () => {
  it("keeps a page's og:image in the store and serves it on the media route, bytes and headers exact", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);
          const { asked, state } = yield* previewedOn(served, CAT);
          const response = yield* served.request(`/api/previews/media/${sha256(png)}`);

          const again = yield* served.request(`/api/previews/media/${sha256(png)}`, {
            headers: { "if-none-match": `W/"other", "${sha256(png)}"` },
          });

          return {
            again: { body: yield* bodyOf(again), headers: headersOf(again), status: again.status },
            asked,
            body: yield* bytesOf(response),
            headers: headersOf(response),
            state,
            status: response.status,
          };
        })
    );

    expect(result.state).toStrictEqual({
      _tag: "Ready",
      preview: {
        description: null,
        image: { animated: false, hash: sha256(png), size: png.length, type: "image/png" },
        kind: "page",
        link: CAT,
        site: "cat.example",
        title: "Cat",
        type: null,
      },
    });
    expect(result.asked).toStrictEqual([
      { link: CAT, purpose: asPageAgain },
      { link: CAT_IMAGE, purpose: asImage },
    ]);
    expect({ body: result.body, status: result.status }).toStrictEqual({ body: png, status: 200 });
    expect(result.headers).toMatchObject({
      "cache-control": "private",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "image/png",
      etag: `"${sha256(png)}"`,
      "x-content-type-options": "nosniff",
    });
    expect(result.again).toMatchObject({
      body: "",
      headers: { "cache-control": "private", etag: `"${sha256(png)}"` },
      status: 304,
    });
  });

  it("answers a Preview kept under on as text only once Previews are links only", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);
          const { state } = yield* previewedOn(served, CAT);
          yield* setPreviews(served, "links only");
          const [place] = yield* messages(served, 1);
          const [item] = yield* settled(served, place ?? { position: "", text: "", timeline: "" });

          return { after: item?.state, before: state };
        })
    );

    expect(imageOf(result.before)?.hash).toBe(sha256(png));
    expect(imageOf(result.after)).toBeNull();
  });

  it("previews a link to an animated GIF as an image, kept, and animated", async () => {
    const link = "https://image.example/cat.gif";

    const result = await run({ [link]: { body: gif, type: "image/gif" } }, (served) =>
      Effect.gen(function* () {
        yield* setBucket(served);

        return yield* previewedOn(served, link);
      })
    );

    expect(result.state).toStrictEqual({
      _tag: "Ready",
      preview: {
        description: null,
        image: { animated: true, hash: sha256(gif), size: gif.length, type: "image/gif" },
        kind: "image",
        link,
        site: "image.example",
        title: null,
        type: "image/gif",
      },
    });
    expect(result.asked).toStrictEqual([
      { link, purpose: asPageAgain },
      { link, purpose: asImage },
    ]);
  });

  it("serves an SVG under a policy that lets it style itself and nothing else", async () => {
    const result = await run(
      {
        [CAT]: page(
          `<title>Cat</title><meta property="og:image" content="https://cdn.example/cat.svg">`
        ),
        "https://cdn.example/cat.svg": { body: svg, type: "image/svg+xml" },
      },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);
          const { state } = yield* previewedOn(served, CAT);
          const response = yield* served.request(`/api/previews/media/${sha256(svg)}`);

          return { body: yield* bytesOf(response), headers: headersOf(response), state };
        })
    );

    expect(imageOf(result.state)).toStrictEqual({
      animated: false,
      hash: sha256(svg),
      size: svg.length,
      type: "image/svg+xml",
    });
    expect(result.body).toStrictEqual(svg);
    expect(result.headers).toMatchObject({
      "cache-control": "private",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "content-type": "image/svg+xml",
      etag: `"${sha256(svg)}"`,
      "x-content-type-options": "nosniff",
    });
  });

  it("fails a 9 MB image as too large, keeping nothing, while the page's text still shows", async () => {
    const big = new Uint8Array(9 * 1024 * 1024);

    big.set(png);

    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: big, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);
          const previewed = yield* previewedOn(served, CAT);

          return {
            ...previewed,
            held: yield* served.world.bytes.store.held,
            logged: served.world.logged,
          };
        })
    );

    expect(result.state).toStrictEqual({
      _tag: "Ready",
      preview: {
        description: null,
        image: null,
        kind: "page",
        link: CAT,
        site: "cat.example",
        title: "Cat",
        type: null,
      },
    });
    expect(result.asked).toContainEqual({ link: CAT_IMAGE, purpose: asImage });
    expect(result.held).toBe(0);
    expect(result.logged.join("\n")).toContain("LinkTooLarge");
  });

  it("fetches no image under links only", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);

          return yield* previewedOn(served, CAT, "links only");
        })
    );

    expect(imageOf(result.state)).toBeNull();
    expect(result.asked).toStrictEqual([{ link: CAT, purpose: asPageAgain }]);
  });

  it("gives text only with no bucket set, and fetches no image", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) => previewedOn(served, CAT)
    );

    expect(result.state).toMatchObject({ _tag: "Ready", preview: { image: null, title: "Cat" } });
    expect(result.asked).toStrictEqual([{ link: CAT, purpose: asPageAgain }]);
  });

  it("gives text only when the store is unreachable", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served, unreachableEndpoint);

          return yield* previewedOn(served, CAT);
        })
    );

    expect(result.state).toMatchObject({ _tag: "Ready", preview: { image: null, title: "Cat" } });
  });

  it("refuses a hash no Preview holds with 404, even one the store holds", async () => {
    const result = await run({}, (served) =>
      Effect.gen(function* () {
        yield* setBucket(served);
        yield* served.world.bytes.store.put(Stream.make(png));
        const response = yield* served.request(`/api/previews/media/${sha256(png)}`);

        const etagged = yield* served.request(`/api/previews/media/${sha256(png)}`, {
          headers: { "if-none-match": "*" },
        });

        return {
          body: decodeError(yield* bodyOf(response)),
          etagged: etagged.status,
          status: response.status,
        };
      })
    );

    expect(result).toStrictEqual({ body: { _tag: "UnknownMedia" }, etagged: 404, status: 404 });
  });

  it("refuses the media route without a key, with 401", async () => {
    const result = await run({}, (served) =>
      Effect.map(
        served.request(`/api/previews/media/${sha256(png)}`, { key: null }),
        (response) => response.status
      )
    );

    expect(result).toBe(401);
  });

  it("answers 503, never kept, when the store is unreachable or no bucket is set", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);
          yield* previewedOn(served, CAT);
          const path = `/api/previews/media/${sha256(png)}`;

          yield* setOption(served, "store.s3.endpoint", unreachableEndpoint);
          const unreachable = yield* served.request(path);

          yield* expecting(
            served.request("/api/options/store.s3.bucket", { method: "DELETE" }),
            200
          );
          const unset = yield* served.request(path);

          return [unreachable, unset].map((response) => ({
            cache: response.headers.get("cache-control"),
            status: response.status,
          }));
        })
    );

    expect(result).toStrictEqual([
      { cache: "no-store", status: 503 },
      { cache: "no-store", status: 503 },
    ]);
  });

  it("keeps a Preview's image when an Upload of the same bytes is deleted", async () => {
    const result = await run(
      { [CAT]: catPage, [CAT_IMAGE]: { body: png, type: "image/png" } },
      (served) =>
        Effect.gen(function* () {
          yield* setBucket(served);
          yield* setOption(served, "uploads.publicUrl", "https://up.example");

          const sent = yield* served.request("/api/uploads", { body: png, method: "POST" });
          const { id, hash } = decodeUploaded(yield* bodyOf(sent));
          const { state } = yield* previewedOn(served, CAT);
          const deleted = yield* served.request(`/api/uploads/${id}`, { method: "DELETE" });
          const response = yield* served.request(`/api/previews/media/${sha256(png)}`);

          return {
            body: yield* bytesOf(response),
            deleted: deleted.status,
            hash,
            image: imageOf(state)?.hash,
            status: response.status,
          };
        })
    );

    expect(result).toStrictEqual({
      body: png,
      deleted: 200,
      hash: sha256(png),
      image: sha256(png),
      status: 200,
    });
  });
});

/**
 * An image no other is the same as, and of the same size as every other: a PNG with four
 * bytes after it, which a reader of the image does not mind.
 * @param shade - What the four bytes are.
 * @returns The bytes.
 */
const tinted = (shade: number) => Uint8Array.of(...png, shade, shade, shade, shade);

/** How many bytes each {@link tinted} image holds. */
const tintedSize = png.length + 4;

/**
 * What each link answers, for pages named for the images they hold: `https://<name>.example/`
 * is a page whose `og:image` is `https://cdn.example/<name>.png`.
 * @param images - Each page's name, and its image.
 * @returns The answers.
 */
const pictured = (images: Readonly<Record<string, Uint8Array>>) => {
  const answers: Record<string, Answer> = {};

  for (const [name, bytes] of Object.entries(images)) {
    answers[`https://${name}.example/`] = page(
      `<title>${name}</title><meta property="og:image" content="https://cdn.example/${name}.png">`
    );
    answers[`https://cdn.example/${name}.png`] = { body: bytes, type: "image/png" };
  }

  return answers;
};

const pageOf = (name: string) => `https://${name}.example/`;

/**
 * Turns Previews on with a bucket, `previews.maxTotal` set, and a Message of a link to each
 * page, and gives each Message's place.
 * @param served - The server.
 * @param names - The pages' names, in the order they are said.
 * @param maxTotal - What `previews.maxTotal` is set to.
 * @returns Each Message's place, in order.
 */
const pictures = (served: Served, names: readonly string[], maxTotal: number) =>
  Effect.gen(function* () {
    yield* setBucket(served);
    yield* setOption(served, "previews.maxTotal", maxTotal);
    yield* setPreviews(served, "on");
    yield* talk(
      served,
      names.map((name) => `see ${pageOf(name)}`)
    );

    return yield* live(messages(served, names.length));
  });

/**
 * What the cache holds of a page: the hash of its image, the one its Preview names, and when
 * it was fetched and last shown.
 * @param served - The server.
 * @param name - The page's name.
 * @returns What it holds, or nothing when it holds no record.
 */
const recordOf = (served: Served, name: string) =>
  Effect.map(served.world.previews.get(pageOf(name)), (kept) =>
    Option.isNone(kept)
      ? undefined
      : {
          fetched: kept.value.fetched,
          image: kept.value.image,
          named: imageOf(kept.value.state)?.hash ?? null,
          shown: kept.value.shown,
        }
  );

/**
 * Whether the store holds bytes.
 * @param served - The server.
 * @param bytes - The bytes.
 * @returns Whether it does.
 */
const inStore = (served: Served, bytes: Uint8Array) =>
  served.world.bytes.store.read(Sha256.make(sha256(bytes))).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  );

/**
 * A Message's Previews, asked until the image its Preview holds is there.
 * @param served - The server.
 * @param place - The Message's place.
 * @returns Its items.
 */
const imaged = (served: Served, place: Place) =>
  Effect.gen(function* () {
    const items = yield* asking(served, place);

    return items.every((one) => imageOf(one.state) !== null && imageOf(one.state) !== undefined)
      ? items
      : yield* new NotYet();
  }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"), Effect.orDie);

const first = 10 * day;

describe("evicting Preview images over a real server", () => {
  it("drops the image of the Preview shown least recently first, releasing its bytes", async () => {
    const images = { aa: tinted(1), bb: tinted(2), cc: tinted(3) };

    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve(pictured(images));

        yield* TestClock.setTime(first);
        const [a, b, c] = yield* pictures(served, ["aa", "bb", "cc"], 2 * tintedSize);

        if (a === undefined || b === undefined || c === undefined) {
          return yield* Effect.die(new Error("a Message is missing"));
        }

        yield* live(settled(served, a));
        yield* TestClock.adjust(1000);
        yield* live(settled(served, b));
        yield* TestClock.adjust(1000);
        yield* asking(served, a);
        yield* TestClock.adjust(1000);
        const held = yield* served.world.bytes.store.held;

        yield* live(settled(served, c));

        return {
          before: held,
          held: yield* served.world.bytes.store.held,
          records: {
            aa: yield* recordOf(served, "aa"),
            bb: yield* recordOf(served, "bb"),
            cc: yield* recordOf(served, "cc"),
          },
          stored: [
            yield* inStore(served, images.aa),
            yield* inStore(served, images.bb),
            yield* inStore(served, images.cc),
          ],
        };
      })
    );

    expect(result).toStrictEqual({
      before: 2 * tintedSize,
      held: 2 * tintedSize,
      records: {
        aa: {
          fetched: first,
          image: sha256(images.aa),
          named: sha256(images.aa),
          shown: first + 1000 * 2,
        },
        bb: { fetched: 0, image: null, named: null, shown: first + 1000 },
        cc: {
          fetched: first + 1000 * 3,
          image: sha256(images.cc),
          named: sha256(images.cc),
          shown: first + 1000 * 3,
        },
      },
      stored: [true, false, true],
    });
  });

  it("evicts down to a lowered previews.maxTotal even for an image a Preview already holds", async () => {
    const images = { aa: tinted(1), bb: tinted(2), cc: tinted(2) };

    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve(pictured(images));

        yield* TestClock.setTime(first);
        const [a, b, c] = yield* pictures(served, ["aa", "bb", "cc"], 2 * tintedSize);

        if (a === undefined || b === undefined || c === undefined) {
          return yield* Effect.die(new Error("a Message is missing"));
        }

        yield* live(settled(served, a));
        yield* TestClock.adjust(1000);
        yield* live(settled(served, b));
        yield* TestClock.adjust(1000);
        yield* setOption(served, "previews.maxTotal", tintedSize);
        yield* live(settled(served, c));

        return {
          held: yield* served.world.bytes.store.held,
          images: [
            (yield* recordOf(served, "aa"))?.image,
            (yield* recordOf(served, "bb"))?.image,
            (yield* recordOf(served, "cc"))?.image,
          ],
        };
      })
    );

    expect(result).toStrictEqual({
      held: tintedSize,
      images: [null, sha256(images.bb), sha256(images.bb)],
    });
  });

  it("serves an evicted Preview's text, and fetches it again, its image included, when it is asked", async () => {
    const images = { aa: tinted(1), bb: tinted(2) };

    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve(pictured(images));

        yield* TestClock.setTime(first);
        const [a, b] = yield* pictures(served, ["aa", "bb"], tintedSize);

        if (a === undefined || b === undefined) {
          return yield* Effect.die(new Error("a Message is missing"));
        }

        yield* live(settled(served, a));
        yield* TestClock.adjust(1000);
        yield* live(settled(served, b));
        const evicted = yield* recordOf(served, "aa");
        const text = yield* asking(served, a);
        const again = yield* live(imaged(served, a));

        return {
          again: again.map((one) => imageOf(one.state)?.hash),
          asked: (yield* served.asked).map(({ link }) => link),
          evicted,
          held: yield* served.world.bytes.store.held,
          other: yield* recordOf(served, "bb"),
          stored: [yield* inStore(served, images.aa), yield* inStore(served, images.bb)],
          text: text.map((one) => [titles([one])[0], imageOf(one.state)]),
        };
      })
    );

    expect(result).toStrictEqual({
      again: [sha256(images.aa)],
      asked: [
        pageOf("aa"),
        "https://cdn.example/aa.png",
        pageOf("bb"),
        "https://cdn.example/bb.png",
        pageOf("aa"),
        "https://cdn.example/aa.png",
      ],
      evicted: { fetched: 0, image: null, named: null, shown: first },
      held: tintedSize,
      other: { fetched: 0, image: null, named: null, shown: first + 1000 },
      stored: [true, false],
      text: [["aa", null]],
    });
  });

  it("keeps an Upload's link while the Preview of the same bytes is evicted", async () => {
    const images = { aa: png, bb: tinted(2) };

    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve(pictured(images));

        yield* TestClock.setTime(first);
        const [a, b] = yield* pictures(served, ["aa", "bb"], tintedSize);

        if (a === undefined || b === undefined) {
          return yield* Effect.die(new Error("a Message is missing"));
        }

        yield* setOption(served, "uploads.publicUrl", "https://up.example");
        const sent = yield* served.request("/api/uploads", { body: png, method: "POST" });
        const { id } = decodeUploaded(yield* bodyOf(sent));

        yield* live(settled(served, a));
        const before = yield* served.request(`/api/previews/media/${sha256(png)}`);

        yield* TestClock.adjust(1000);
        yield* live(settled(served, b));
        const preview = yield* served.request(`/api/previews/media/${sha256(png)}`);
        const upload = yield* served.request(`/api/uploads/${id}/content`);

        return {
          before: before.status,
          held: yield* served.world.bytes.store.held,
          preview: preview.status,
          record: yield* recordOf(served, "aa"),
          upload: { body: yield* bytesOf(upload), status: upload.status },
        };
      })
    );

    expect(result).toStrictEqual({
      before: 200,
      held: png.length + tintedSize,
      preview: 404,
      record: { fetched: 0, image: null, named: null, shown: first },
      upload: { body: png, status: 200 },
    });
  });

  it("keeps the references across a restart, so an image kept before it is evicted, and its bytes released, by one put after it", async () => {
    const images = { aa: tinted(1), bb: tinted(2) };

    const result = await runClocked(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const file = `${dataDir}/previews.sqlite`;

        const opened = makeSqlitePreviewCache(file).pipe(
          Effect.provide(BunFileSystem.layer),
          Effect.orDie
        );

        yield* TestClock.setTime(first);

        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const served = yield* serve(pictured(images), {
              left: { dataDir, key },
              previews: yield* opened,
            });

            const [a, b] = yield* pictures(served, ["aa", "bb"], tintedSize);

            if (a === undefined || b === undefined) {
              return yield* Effect.die(new Error("a Message is missing"));
            }

            yield* live(settled(served, a));

            return {
              left: { dataDir, journal: served.world.journal, key, store: served.world.store },
              places: { a, b },
            };
          })
        );

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const served = yield* serve(pictured(images), {
              left: before.left,
              previews: yield* opened,
            });

            // The bucket outlives the Daemon, which the world's store in memory does not.
            yield* setBucket(served);
            yield* served.world.bytes.store.put(Stream.make(images.aa));
            yield* TestClock.adjust(1000);
            const referred = yield* served.world.previews.refers(Sha256.make(sha256(images.aa)));

            yield* live(settled(served, before.places.b));

            return {
              held: yield* served.world.bytes.store.held,
              records: {
                aa: yield* recordOf(served, "aa"),
                bb: yield* recordOf(served, "bb"),
              },
              referred,
              stored: [yield* inStore(served, images.aa), yield* inStore(served, images.bb)],
            };
          })
        );
      })
    );

    expect(result).toStrictEqual({
      held: tintedSize,
      records: {
        aa: { fetched: 0, image: null, named: null, shown: first },
        bb: {
          fetched: first + 1000,
          image: sha256(images.bb),
          named: sha256(images.bb),
          shown: first + 1000,
        },
      },
      referred: true,
      stored: [false, true],
    });
  });

  it("keeps no image larger than previews.maxTotal, and evicts nothing for it", async () => {
    const images = { aa: tinted(1), big: Uint8Array.of(...tinted(2), ...new Uint8Array(100)) };

    const result = await runClocked(
      Effect.gen(function* () {
        const served = yield* serve(pictured(images));

        yield* TestClock.setTime(first);
        const [a, big] = yield* pictures(served, ["aa", "big"], tintedSize);

        if (a === undefined || big === undefined) {
          return yield* Effect.die(new Error("a Message is missing"));
        }

        yield* live(settled(served, a));
        yield* TestClock.adjust(1000);
        const items = yield* live(settled(served, big));

        return {
          held: yield* served.world.bytes.store.held,
          items: items.map((one) => [titles([one])[0], imageOf(one.state)]),
          records: { aa: yield* recordOf(served, "aa"), big: yield* recordOf(served, "big") },
          stored: yield* inStore(served, images.aa),
        };
      })
    );

    expect(result).toStrictEqual({
      held: tintedSize,
      items: [["big", null]],
      records: {
        aa: {
          fetched: first,
          image: sha256(images.aa),
          named: sha256(images.aa),
          shown: first,
        },
        big: { fetched: first + 1000, image: null, named: null, shown: first + 1000 },
      },
      stored: true,
    });
  });
});

/**
 * Presses a link of a Message waiting for a press.
 * @param served - The server.
 * @param place - The Message's place.
 * @param link - The link's index among the Message's links.
 * @param init - Headers and the key, to press otherwise than with the key.
 * @returns The response.
 */
const press = (
  served: Served,
  place: Pick<Place, "timeline" | "position">,
  link: number,
  init: RequestInit & { readonly key?: string | null } = {}
) =>
  served.request(`/api/timelines/${place.timeline}/previews/press`, {
    method: "POST",
    ...json({ link, position: place.position }),
    ...init,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });

/**
 * Sets `ui.previews.timelines`, whole.
 * @param served - The server.
 * @param timelines - Each Timeline's id, and its mode.
 * @returns An Effect that sets it.
 */
const setOverrides = (served: Served, timelines: Readonly<Record<string, string>>) =>
  expecting(
    served.request("/api/ui/previews.timelines", { method: "PUT", ...json({ value: timelines }) }),
    200
  );

/**
 * The place of the one Message in a kind of Timeline, once it is there.
 * @param served - The server.
 * @param kind - The Timeline's kind.
 * @returns Its place.
 */
const only = (served: Served, kind: "Channel" | "Direct") =>
  Effect.gen(function* () {
    const [place] = yield* messages(served, 1, kind);

    return place ?? { position: "", text: "", timeline: "" };
  });

/**
 * A status and the error's tag a response answered, to compare.
 * @param response - The response.
 * @returns The status and the tag.
 */
const refusal = (response: Response) =>
  Effect.gen(function* () {
    return [response.status, decodeError(yield* bodyOf(response))._tag] as const;
  });

describe("a Direct Message's press and a Timeline's override over a real server", () => {
  it("fetches a link of a Direct Message once it is pressed, answering it pending, and refuses a second press", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "on");
        yield* talk(served, ["https://cats.example/"], ["iirc"]);
        const place = yield* only(served, "Direct");
        const before = yield* settled(served, place);
        const pressed = yield* expecting(press(served, place, 0), 200);
        const answered = decodeItem(yield* bodyOf(pressed));
        const after = yield* settled(served, place);
        const again = yield* refusal(yield* press(served, place, 0));

        return {
          again,
          answered: answered.state,
          asked: yield* served.asked,
          before: before.map(stateOf),
          titles: titles(after),
        };
      })
    );

    expect(result).toStrictEqual({
      again: [409, "NotWaiting"],
      answered: { _tag: "Pending" },
      asked: [{ link: "https://cats.example/", purpose: { kind: "page" } }],
      before: [{ _tag: "WaitingForPress" }],
      titles: ["Cats"],
    });
  });

  it("streams a pressed link's changes, pending then ready, to a Frontend that did not press", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["https://cats.example/"], ["iirc"]);
        const place = yield* only(served, "Direct");
        const following = yield* served.request("/api/previews/changes");

        // The stream is followed before the press, which its first heartbeat says.
        const body: ReadableStream<Uint8Array> | null = following.body;
        const reader = body?.getReader();
        const decoder = new TextDecoder();
        let text = "";

        const until = (done: (text: string) => boolean) =>
          Effect.promise(async () => {
            while (!done(text)) {
              // oxlint-disable-next-line no-await-in-loop -- reading a stream in order
              const chunk = await reader?.read();

              if (chunk === undefined || chunk.done) {
                return;
              }

              text += decoder.decode(chunk.value, { stream: true });
            }
          });

        yield* until((read) => read.includes("event: heartbeat"));
        yield* press(served, place, 0);
        yield* until((read) => read.includes('"Ready"'));
        yield* Effect.promise(async () => await reader?.cancel());

        return [...text.matchAll(/"_tag":"(?<tag>Pending|Ready)"/gu)].map(
          (found) => found.groups?.tag
        );
      })
    );

    expect(result).toStrictEqual(["Pending", "Ready"]);
  });

  it("refuses a press of a link that is not waiting, with 409, and fetches nothing", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "on");
        yield* talk(served, ["https://cats.example/"], ["#iirc", "iirc"]);
        const channel = yield* only(served, "Channel");
        const direct = yield* only(served, "Direct");
        const inChannel = yield* refusal(yield* press(served, channel, 0));
        const past = yield* refusal(yield* press(served, direct, 1));

        yield* setOverrides(served, { [direct.timeline]: "links only" });
        const overridden = yield* refusal(yield* press(served, direct, 0));

        return { asked: yield* served.asked, inChannel, overridden, past };
      })
    );

    expect(result).toStrictEqual({
      asked: [],
      inChannel: [409, "NotWaiting"],
      overridden: [409, "NotWaiting"],
      past: [409, "NotWaiting"],
    });
  });

  it("refuses a press of an unknown Timeline or Message, or while Previews are off", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* talk(served, ["https://cats.example/"], ["iirc"]);
        const place = yield* only(served, "Direct");
        const off = yield* refusal(yield* press(served, place, 0));

        yield* setPreviews(served, "on");

        const timeline = yield* refusal(
          yield* press(served, { ...place, timeline: "0000000000ffff-00000000-00000000" }, 0)
        );

        const message = yield* refusal(
          yield* press(
            served,
            { ...place, position: place.position.replace(/-[0-9a-f]{8}$/u, "-0000ffff") },
            0
          )
        );

        return { asked: yield* served.asked, message, off, timeline };
      })
    );

    expect(result).toStrictEqual({
      asked: [],
      message: [404, "UnknownMessage"],
      off: [409, "PreviewsOff"],
      timeline: [404, "UnknownTimeline"],
    });
  });

  it("takes a press only with a key, and by a sign-in's cookie only from the Daemon's own origin", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "on");
        yield* talk(served, ["https://cats.example/"], ["iirc"]);
        const place = yield* only(served, "Direct");

        const signedIn = yield* served.request("/api/sign-in", {
          ...json({ key: served.key }),
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          key: null,
          method: "POST",
        });

        const token = /^iirc_sign_in=(?<token>[^;]+)/u.exec(
          signedIn.headers.getSetCookie()[0] ?? ""
        )?.groups?.token;

        const asBrowser = (site: string) =>
          press(served, place, 0, {
            headers: { cookie: `iirc_sign_in=${token ?? ""}`, "sec-fetch-site": site },
            key: null,
          });

        const keyless = yield* refusal(yield* press(served, place, 0, { key: null }));
        const crossSite = yield* refusal(yield* asBrowser("cross-site"));
        const fetchedAfterRefusals = (yield* served.asked).length;
        const sameOrigin = yield* asBrowser("same-origin");

        return { crossSite, fetchedAfterRefusals, keyless, sameOrigin: sameOrigin.status };
      })
    );

    expect(result).toStrictEqual({
      crossSite: [403, "CrossOrigin"],
      fetchedAfterRefusals: 0,
      keyless: [401, "Unauthorized"],
      sameOrigin: 200,
    });
  });

  it("fetches a Direct Message's link unasked once the Timeline is overridden on, or links only", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "off");
        yield* talk(served, ["https://cats.example/"], ["iirc"]);
        const place = yield* only(served, "Direct");

        yield* setOverrides(served, { [place.timeline]: "on" });
        const items = yield* settled(served, place);

        return { asked: yield* served.asked, titles: titles(items) };
      })
    );

    expect(result).toStrictEqual({
      asked: [{ link: "https://cats.example/", purpose: { kind: "page" } }],
      titles: ["Cats"],
    });
  });

  it("answers Previews off for a Channel overridden off while ui.previews is on, and fetches nothing", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "on");
        yield* talk(served, ["https://cats.example/"]);
        const place = yield* only(served, "Channel");

        yield* setOverrides(served, { [place.timeline]: "off" });
        const refused = yield* refusal(yield* ask(served, place));

        return { asked: yield* served.asked, refused };
      })
    );

    expect(result).toStrictEqual({ asked: [], refused: [409, "PreviewsOff"] });
  });

  it("fetches a Channel's link overridden on while ui.previews is off", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* talk(served, ["https://cats.example/"]);
        const place = yield* only(served, "Channel");

        yield* setOverrides(served, { [place.timeline]: "on" });
        const items = yield* settled(served, place);

        return { asked: yield* served.asked, titles: titles(items) };
      })
    );

    expect(result).toStrictEqual({
      asked: [{ link: "https://cats.example/", purpose: { kind: "page" } }],
      titles: ["Cats"],
    });
  });

  it("serves a link a Channel fetched in a Direct Message with no press, fetching nothing more", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["https://cats.example/"], ["#iirc", "iirc"]);
        const channel = yield* only(served, "Channel");
        const direct = yield* only(served, "Direct");
        const waiting = yield* asking(served, direct);

        yield* settled(served, channel);
        const served_ = yield* asking(served, direct);

        return {
          asked: (yield* served.asked).length,
          served: titles(served_),
          waiting: waiting.map(stateOf),
        };
      })
    );

    expect(result).toStrictEqual({
      asked: 1,
      served: ["Cats"],
      waiting: [{ _tag: "WaitingForPress" }],
    });
  });

  it("refuses an override whose key is not a Timeline's id with 400, keeping what was set", async () => {
    const result = await run({}, (served) =>
      Effect.gen(function* () {
        const refused = yield* refusal(
          yield* served.request("/api/ui/previews.timelines", {
            method: "PUT",
            ...json({ value: { "#iirc": "on" } }),
          })
        );

        const { options } = yield* Schema.decodeEffect(Schema.fromJsonString(UiInForce))(
          yield* bodyOf(yield* served.request("/api/ui"))
        );

        return { refused, timelines: options["previews.timelines"] };
      })
    );

    expect(result).toStrictEqual({
      refused: [400, "InvalidRequest"],
      timelines: {},
    });
  });

  it("decides a merged Timeline's Previews by the Timeline it went to, never the merged id's override", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        const configured = yield* served.request("/api/networks/libera", {
          method: "PUT",
          ...json(floor),
        });

        expect(configured.status).toBe(200);
        const call = yield* registerOnFloor(served.world.memory);

        yield* say(call, ":irc.test 005 iirc CASEMAPPING=ascii :are supported by this server");
        yield* say(call, ":a[!u@h PRIVMSG iirc :first");
        yield* say(call, ":a{!u@h PRIVMSG iirc :see https://cats.example/");

        const named = (name: string) =>
          Effect.gen(function* () {
            const listed = decodeList(
              yield* bodyOf(yield* served.request("/api/networks/libera/timelines"))
            );

            const found = listed.timelines.find((one) => one.name === name);

            return found === undefined ? yield* new NotYet() : found.id;
          }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"));

        const kept = yield* named("a[");
        const merged = yield* named("a{");

        const window = decodeWindow(
          yield* bodyOf(yield* served.request(`/api/timelines/${merged}?limit=50`))
        );

        const place = { position: window.items.at(-1)?.position ?? "", text: "", timeline: merged };

        yield* say(call, ":irc.test 005 iirc -CASEMAPPING :are supported by this server");
        // Once merged, the Network lists only the Timeline it went to.
        yield* Effect.gen(function* () {
          const listed = decodeList(
            yield* bodyOf(yield* served.request("/api/networks/libera/timelines"))
          );

          return listed.timelines.some((one) => one.id === merged) ? yield* new NotYet() : true;
        }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"));

        yield* setPreviews(served, "links only");
        // The merged id is `on`, but the Direct Message it went to has no override, so it waits.
        yield* setOverrides(served, { [merged]: "on" });
        const waiting = yield* asking(served, place);

        // The Timeline it went to is `off`, which the merged id's `on` never overrides.
        yield* setOverrides(served, { [kept]: "off", [merged]: "on" });
        const off = yield* refusal(yield* press(served, place, 0));

        return {
          asked: (yield* served.asked).length,
          off,
          waiting: waiting.map(stateOf),
        };
      })
    );

    expect(result).toStrictEqual({
      asked: 0,
      off: [409, "PreviewsOff"],
      waiting: [{ _tag: "WaitingForPress" }],
    });
  });

  it("accepts an override for a Timeline that does not exist, and changes nothing", async () => {
    const result = await run({ "https://cats.example/": cats }, (served) =>
      Effect.gen(function* () {
        yield* setPreviews(served, "links only");
        yield* talk(served, ["https://cats.example/"], ["#iirc", "iirc"]);
        const channel = yield* only(served, "Channel");
        const direct = yield* only(served, "Direct");
        const before = yield* asking(served, direct);

        yield* setOverrides(served, { "0000000000ffff-00000000-00000000": "off" });
        const waiting = yield* asking(served, direct);
        const fetchedByThen = (yield* served.asked).length;
        const items = yield* settled(served, channel);

        return {
          asked: (yield* served.asked).length,
          before: before.map(stateOf),
          fetchedByThen,
          titles: titles(items),
          waiting: waiting.map(stateOf),
        };
      })
    );

    expect(result).toStrictEqual({
      asked: 1,
      before: [{ _tag: "WaitingForPress" }],
      fetchedByThen: 0,
      titles: ["Cats"],
      waiting: [{ _tag: "WaitingForPress" }],
    });
  });
});

/**
 * Says each link to Self in the Channel, three to a Message, with Previews on.
 * @param served - The server.
 * @param links - The links, in the order a peer says them.
 * @returns Each Message's place, in order.
 */
const saying = (served: Served, links: readonly string[]) =>
  Effect.gen(function* () {
    yield* setPreviews(served, "links only");

    const texts = Array.from({ length: Math.ceil(links.length / 3) }, (_, at) =>
      links.slice(at * 3, at * 3 + 3).join(" ")
    );

    yield* talk(served, texts);

    return yield* live(messages(served, texts.length));
  });

/**
 * Asks for each Message's Previews in turn, which starts the fetch of each link in the order
 * they were said.
 * @param served - The server.
 * @param places - The Messages' places.
 * @returns Every item answered, in order.
 */
const askingEach = (served: Served, places: readonly Place[]) =>
  Effect.gen(function* () {
    const items: PreviewItem[] = [];

    for (const place of places) {
      items.push(...(yield* asking(served, place)));
    }

    return items;
  });

/**
 * Each change a changes stream has carried, in order.
 * @param text - What was read of the stream.
 * @returns Each change's link and the tag of its state.
 */
const changesIn = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.startsWith("event: changed"))
    .flatMap((block) => {
      const fields = new Map(
        block
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)])
      );

      const event = decodeEvent({ data: fields.get("data"), event: fields.get("event") });

      return event.event === "changed" ? [[event.data.link, event.data.state._tag] as const] : [];
    });

/** Waits on the real clock, long enough for a fetch that was going to start to have started. */
const settling = live(Effect.sleep("200 millis"));

/**
 * A server on a link fetch that holds the given links, and what each asked link answers.
 * @param links - The links, each answering a page.
 * @param held - The links held until they are released.
 * @returns The server, and the link fetch.
 */
const holding = (links: readonly string[], held: readonly string[] = []) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeLinkFetch(Object.fromEntries(links.map((link) => [link, cats])), {
      held,
    });

    return { fake, served: yield* serve({}, { links: fake }) };
  });

/**
 * The links fetched so far, in the order their fetches were made.
 * @param served - The server.
 * @returns The links.
 */
const linksAsked = (served: Served) =>
  served.asked.pipe(Effect.map((all) => all.map((one) => one.link)));

/**
 * Waits until the link fetch has been asked at least as many times as given, so that a pacer
 * that lets too many through fails the test's own assertions rather than a wait.
 * @param served - The server.
 * @param count - How many.
 * @returns An Effect that ends when it has.
 */
const reaching = (served: Served, count: number) =>
  live(
    Effect.gen(function* () {
      return (yield* served.asked).length >= count ? count : yield* new NotYet();
    }).pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"), Effect.orDie)
  );

describe("bounds and the queue over a real server", () => {
  const same = ["https://one.example/a", "https://one.example/b", "https://one.example/c"];

  it("makes a third fetch to one name wait until one of the first two finishes", async () => {
    const result = await runClocked(
      Effect.gen(function* () {
        const { fake, served } = yield* holding(same, same);
        const places = yield* saying(served, same);
        const stream = yield* follow(served);
        const answered = yield* askingEach(served, places);

        yield* reaching(served, 2);
        yield* settling;

        const waiting = {
          asked: yield* linksAsked(served),
          states: (yield* askingEach(served, places)).map(stateOf),
        };

        yield* fake.release("https://one.example/a");
        yield* reaching(served, 3);
        yield* fake.release("https://one.example/b");
        yield* fake.release("https://one.example/c");
        yield* stream.until(
          (read) => changesIn(read).filter(([, tag]) => tag === "Ready").length === 3
        );
        yield* stream.stop;

        return {
          answered: answered.map(stateOf),
          changes: changesIn(stream.text()),
          fetched: yield* linksAsked(served),
          settled: titles(
            yield* live(settled(served, places[0] ?? { position: "", text: "", timeline: "" }))
          ),
          waiting,
        };
      })
    );

    expect(result.answered).toStrictEqual([
      { _tag: "Pending" },
      { _tag: "Pending" },
      { _tag: "Pending" },
    ]);

    expect(result.waiting).toStrictEqual({
      asked: ["https://one.example/a", "https://one.example/b"],
      states: [{ _tag: "Pending" }, { _tag: "Pending" }, { _tag: "Pending" }],
    });

    expect(result.fetched).toStrictEqual(same);
    expect(result.settled).toStrictEqual(["Cats", "Cats", "Cats"]);
    expect(result.changes.map(([, tag]) => tag).filter((tag) => tag !== "Pending")).toStrictEqual([
      "Ready",
      "Ready",
      "Ready",
    ]);
  });

  it("makes a 31st fetch in a minute wait until the minute turns, and never fails it", async () => {
    const names = Array.from({ length: 31 }, (_, at) => `https://h${at + 1}.example/`);

    const result = await runClocked(
      Effect.gen(function* () {
        const { served } = yield* holding(names);
        const places = yield* saying(served, names);
        const stream = yield* follow(served);
        const answered = yield* askingEach(served, places);

        yield* reaching(served, 30);
        yield* stream.until(
          (read) =>
            changesIn(read).filter(([, tag]) => tag === "Ready").length === 30 &&
            changesIn(read).some(([link]) => link === names[30])
        );

        yield* settling;

        const beforeMinute = {
          asked: (yield* served.asked).length,
          last: changesIn(stream.text())
            .filter(([link]) => link === names[30])
            .map(([, tag]) => tag),
        };

        yield* TestClock.adjust(59_999);
        yield* settling;
        const justBefore = (yield* served.asked).length;

        yield* TestClock.adjust(1);
        yield* reaching(served, 31);
        yield* stream.until((read) =>
          changesIn(read).some(([link, tag]) => link === names[30] && tag === "Ready")
        );
        yield* stream.stop;

        return {
          answered: answered.at(-1)?.state,
          beforeMinute,
          changes: changesIn(stream.text()),
          justBefore,
        };
      })
    );

    expect(result.answered).toStrictEqual({ _tag: "Pending" });
    expect(result.beforeMinute).toStrictEqual({ asked: 30, last: ["Pending"] });
    expect(result.justBefore).toBe(30);

    expect(
      result.changes.filter(([link]) => link === names[30]).map(([, tag]) => tag)
    ).toStrictEqual(["Pending", "Ready"]);

    expect(result.changes.filter(([, tag]) => tag === "Failed")).toStrictEqual([]);
  });

  it("fetches the fetches that waited for the minute in the order they were asked", async () => {
    const names = Array.from({ length: 32 }, (_, at) => `https://h${at + 1}.example/`);

    const result = await runClocked(
      Effect.gen(function* () {
        const { served } = yield* holding(names);
        const places = yield* saying(served, names);

        yield* askingEach(served, places);
        yield* reaching(served, 30);
        yield* settling;
        const before = yield* linksAsked(served);

        yield* TestClock.adjust(60_000);
        yield* reaching(served, 32);

        return { after: yield* linksAsked(served), before };
      })
    );

    expect(result.before).toStrictEqual(names.slice(0, 30));
    expect(result.after).toStrictEqual(names);
  });

  it("gives a name's places to its waiting fetches in the order they were asked, as earlier ones finish", async () => {
    const links = ["a", "b", "c", "d"].map((one) => `https://one.example/${one}`);

    const result = await runClocked(
      Effect.gen(function* () {
        const { fake, served } = yield* holding(links, links);
        const places = yield* saying(served, links);

        yield* askingEach(served, places);
        yield* reaching(served, 2);
        yield* settling;
        const first = yield* linksAsked(served);

        yield* fake.release("https://one.example/b");
        yield* reaching(served, 3);
        yield* settling;
        const second = yield* linksAsked(served);

        yield* fake.release("https://one.example/a");
        yield* reaching(served, 4);

        return { first, second, third: yield* linksAsked(served) };
      })
    );

    expect(result.first).toStrictEqual(links.slice(0, 2));
    expect(result.second).toStrictEqual(links.slice(0, 3));
    expect(result.third).toStrictEqual(links);
  });
});
