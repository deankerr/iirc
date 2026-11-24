/** The Tail through a real Daemon: who may read it, what it holds, and how it is followed. */
import { NetworkId } from "@iirc/api";
import type { TailEvent, TailLine } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect, Logger, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { freePort, loopback } from "./testing/children.ts";
import { eventually, startDaemon } from "./testing/running.ts";
import { makeKey, temporaryDirectory } from "./testing/world.ts";

// No logger, so what the Daemon logs is not printed over the test run. Its Tail still holds it.
const quiet = Logger.layer([]);

const run = async <A, E>(
  test: (
    daemon: Effect.Success<ReturnType<typeof startDaemon>> & { readonly key: string }
  ) => Effect.Effect<A, E, Scope.Scope>
) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory;
        const key = yield* makeKey(dataDir);
        const daemon = yield* startDaemon({ dataDir, heartbeat: "50 millis" }, key);

        return yield* test({ ...daemon, key });
      })
    ).pipe(Effect.provide(quiet))
  );

/**
 * What a request is answered, with no wait for a stream to end.
 * @param url - What to ask.
 * @param key - The key to present, if any.
 * @returns The status.
 */
const statusOf = async (url: string, key: string | undefined) => {
  const response = await fetch(url, {
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  });

  await response.body?.cancel();

  return response.status;
};

const lineOf = (event: TailEvent): TailLine | undefined =>
  event.event === "line" ? event.data : undefined;

// The line the Daemon logs as a `ui` option changes, which names it among its words.
const changed = (line: TailLine | undefined, option: string) =>
  line?.message.startsWith("Changed ui option") === true && line.message.includes(`"${option}"`);

describe("the Tail, through a Daemon", () => {
  it("refuses a request with no key and no sign-in, and answers one with a key", async () => {
    const answers = await run(({ base, key }) =>
      Effect.promise(async () => [
        await statusOf(`${base}/api/tail`, undefined),
        await statusOf(`${base}/api/tail/changes`, undefined),
        await statusOf(`${base}/api/tail`, key),
        await statusOf(`${base}/api/tail/changes`, key),
      ])
    );

    expect(answers).toStrictEqual([401, 401, 200, 200]);
  });

  it("starts with the Daemon's start line, at Info, with its version", async () => {
    const read = await run(({ api }) => api.tail.read());

    expect(read.version).toBe("0.0.0");
    expect(read.started).toBeGreaterThan(0);
    expect(read.lines[0]).toMatchObject({ annotations: { version: "0.0.0" }, level: "Info", n: 1 });
  });

  it("holds a line logged inside the Runtime, with its Network's annotation", async () => {
    const network = NetworkId.make("deep");

    const annotated = await run(({ api }) =>
      Effect.gen(function* () {
        yield* api.networks.configure({
          params: { network },
          payload: configured({ ircds: [{ host: loopback, port: freePort(), tls: false }] }),
          query: {},
        });

        const read = yield* eventually(api.tail.read(), ({ lines }) =>
          lines.some((line) => line.annotations.network === network)
        );

        return read.lines.filter((line) => line.annotations.network === network).length;
      })
    );

    expect(annotated).toBeGreaterThan(0);
  });

  it("streams the Daemon first, then each line held, then each as it is logged", async () => {
    const events = await run(({ api }) =>
      Effect.gen(function* () {
        const stream = yield* api.tail.changes({ headers: {}, query: {} });
        const seen: TailEvent[] = [];

        yield* stream.pipe(
          Stream.takeUntil((event) => {
            seen.push(event);

            return changed(lineOf(event), "timeline.timeFormat");
          }),
          // The start line is held, so the stream is open once it is seen, and this
          // line is logged after, so it can only arrive as it is logged.
          Stream.tap((event) =>
            lineOf(event)?.n === 1
              ? api.ui.set({
                  params: { option: "timeline.timeFormat" },
                  payload: { value: "none" },
                  query: {},
                })
              : Effect.void
          ),
          Stream.runDrain
        );

        return seen;
      })
    );

    expect(events[0]?.event).toBe("daemon");
    expect(events.slice(1).map((event) => event.event)).not.toContain("daemon");

    const lines = events.flatMap((event) => lineOf(event) ?? []);

    expect(lines.map((line) => line.n)).toStrictEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1)
    );
    expect(
      events.flatMap((event) => (event.event === "line" ? [event.id === event.data.n] : []))
    ).not.toContain(false);
  });

  it("resumes after a number, by query or by Last-Event-ID, which wins, missing and doubling nothing", async () => {
    const { byHeader, byQuery, held } = await run(({ api }) =>
      Effect.gen(function* () {
        const before = yield* api.tail.read();
        const held = before.lines.at(-1)?.n ?? 0;

        // Two lines logged after the last the Frontend saw, one before it follows, and
        // one as it follows.
        yield* api.ui.set({
          params: { option: "timeline.timeFormat" },
          payload: { value: "none" },
          query: {},
        });

        const follow = (resume: {
          readonly headers: { readonly "last-event-id"?: number };
          readonly query: { readonly after?: number };
        }) =>
          Effect.gen(function* () {
            const stream = yield* api.tail.changes(resume);
            const numbers: number[] = [];

            yield* stream.pipe(
              Stream.takeUntil((event) => changed(lineOf(event), "font")),
              Stream.tap((event) => {
                const line = lineOf(event);

                if (line !== undefined) {
                  numbers.push(line.n);
                }

                return numbers.length === 1
                  ? api.ui.set({
                      params: { option: "font" },
                      payload: { value: "mono" },
                      query: {},
                    })
                  : Effect.void;
              }),
              Stream.runDrain
            );

            return numbers;
          });

        const byQuery = yield* follow({ headers: {}, query: { after: held } });
        const byHeader = yield* follow({ headers: { "last-event-id": held }, query: { after: 0 } });

        return { byHeader, byQuery, held };
      })
    );

    // Every number after the one held, once each, in order, to the last.
    const last = byQuery.at(-1) ?? 0;

    expect(byQuery).toStrictEqual(
      Array.from({ length: last - held }, (_, index) => held + 1 + index)
    );
    expect(byQuery.length).toBeGreaterThanOrEqual(2);
    expect(byHeader.slice(0, byQuery.length)).toStrictEqual(byQuery);
  });
});
