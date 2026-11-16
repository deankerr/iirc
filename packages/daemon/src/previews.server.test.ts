import { BunHttpServer } from "@effect/platform-bun";
import { MessagePreviews, PreviewsEvent, TimelineList } from "@iirc/api";
import type { PreviewItem } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { LinkRefused, LinkTimedOut, LinkTooLarge, LinkWrongType } from "@iirc/link-fetch";
import type { Answer, Asked } from "@iirc/link-fetch/testing";
import { makeFakeLinkFetch } from "@iirc/link-fetch/testing";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import type { Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";

import { ApiRoutes, Heartbeat } from "./handlers.ts";
import {
  heard,
  layerWorld,
  makeKey,
  makeWorld,
  registerOnFloor,
  say,
  temporaryDirectory,
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
  readonly asked: Effect.Effect<readonly Asked[]>;
  readonly key: string;
  readonly world: World;
}

/**
 * Serves the API over a real Bun server on an ephemeral loopback port, on the in-memory
 * ports, with the fake link fetch answering as told.
 * @param answers - What each link answers.
 * @returns The server, which stops when the Scope closes.
 */
const serve = (answers: Readonly<Record<string, Answer>>) =>
  Effect.gen(function* () {
    const dataDir = yield* temporaryDirectory;
    const key = yield* makeKey(dataDir);
    const fake = yield* makeFakeLinkFetch(answers);
    const world = yield* makeWorld(undefined, undefined, fake.service);

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

const bodyOf = (response: Response) => Effect.promise(async () => await response.text());

const json = (value: Schema.Json): RequestInit => ({
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
});

const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(TimelineList));

const decodePreviews = Schema.decodeUnknownSync(Schema.fromJsonString(MessagePreviews));

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

/**
 * Configures `libera`, registers it on the floor, joins `#iirc`, and has a peer say each
 * text there, or to Self in a Direct Message.
 * @param served - The server.
 * @param texts - What the peer says.
 * @param where - Where it says them.
 * @returns An Effect that does it.
 */
const talk = (served: Served, texts: readonly string[], where: "#iirc" | "iirc" = "#iirc") =>
  Effect.gen(function* () {
    const configured = yield* served.request("/api/networks/libera", {
      method: "PUT",
      ...json(floor),
    });

    expect(configured.status).toBe(200);
    const call = yield* registerOnFloor(served.world.memory);

    yield* say(call, ":iirc!u@h JOIN #iirc");

    for (const text of texts) {
      yield* say(call, `:peer!u@h PRIVMSG ${where} :${text}`);
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
  preview: { description: null, kind, link, site: new URL(link).host, title: null, type },
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
        yield* talk(served, ["https://cats.example/"], "iirc");
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
