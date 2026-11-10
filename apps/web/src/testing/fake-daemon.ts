/**
 * What the web frontend's tests share: a fake Daemon at the `fetch` level, a registry whose
 * runtime reaches it, and ways to wait on a command and to look for a secret.
 *
 * @packageDocumentation
 */
import type {
  Knowledge,
  NetworkEntry,
  Timeline,
  TimelineChangesEvent,
  TimelineItem,
  TimelineList,
  TimelineWindow,
  WindowGap,
} from "@iirc/api";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

import { layerDaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { Waits } from "../timelines/atoms.ts";
import type { WaitTimes } from "../timelines/atoms.ts";

export const theKey = "iirc_the-key";

/** What the Daemon answers with, as the wire carries it. */
type Answer =
  | Readonly<Record<string, string>>
  | (typeof NetworkEntry.Encoded)[]
  | typeof Knowledge.Encoded
  | typeof TimelineList.Encoded
  | typeof TimelineWindow.Encoded;

const json = (status: number, body: Answer) => Response.json(body, { status });

/** A Timeline the fake holds: its description, and its items in position order. */
export interface FakeTimeline {
  readonly timeline: typeof Timeline.Encoded;
  items: (typeof TimelineItem.Encoded)[];
  gaps: (typeof WindowGap.Encoded)[];
}

/** One follower of the changes stream: where it asked to follow from, and its stream. */
interface Follower {
  readonly after: string | undefined;
  readonly lastEventId: string | undefined;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * Its window of a Timeline, as the Daemon would give it: the latest, or the last before a
 * cursor, up to a limit, with every Gap it holds.
 * @param held - The Timeline.
 * @param query - The query.
 * @param through - The last step folded.
 * @returns The window.
 */
const windowOf = (
  held: FakeTimeline,
  query: URLSearchParams,
  through: number
): typeof TimelineWindow.Encoded => {
  const before = query.get("before");
  const limit = Number(query.get("limit") ?? "100");

  const candidates =
    before === null ? held.items : held.items.filter((item) => item.position < before);

  const items = candidates.slice(-limit);

  return {
    earlier: candidates.length > items.length,
    gaps: held.gaps,
    items,
    later: before !== null,
    network: held.timeline.network,
    through,
    timeline: held.timeline.id,
    version: 1,
  };
};

const SignInBody = Schema.fromJsonString(Schema.Struct({ key: Schema.String }));

/**
 * Whether a redacted value still holds its value.
 * @param redacted - The value.
 * @returns `false` once it was wiped.
 */
export const hasValue = (redacted: Redacted.Redacted<unknown>) => {
  try {
    Redacted.value(redacted);

    return true;
  } catch {
    return false;
  }
};

/**
 * A Daemon's sign-in routes and Network list as the wire carries them, with one key and
 * the one cookie a browser would hold. It can be down, answer through a gateway that
 * cannot reach it, or fail to write its sign-ins.
 * @returns What the fake holds, which a test may change, and its `fetch`.
 */
export const fakeDaemon = () => {
  const keysSent: string[] = [];

  const followers: Follower[] = [];
  const windowsRead: string[] = [];
  const hung: string[] = [];
  const networksHeld: (() => void)[] = [];

  const daemon = {
    /** How many requests that never began their answer were given up. */
    abandoned: 0,
    down: false,
    followers,
    gatewayOnly: false,
    /** Whether a request to follow the changes never begins its answer. */
    hangChanges: false,
    /** Whether each request for the Network list waits until released. */
    holdNetworks: false,
    /** Where each request that never began its answer asked to follow from. */
    hung,
    keysSent,
    /** Releases each request for the Network list held, in the order they came. */
    networksHeld,
    /** Each Network's connection, as `known` gives it. */
    sessions: new Map<string, (typeof Knowledge.Encoded)["session"]>([
      ["libera", { _tag: "Registered", ircd: "ircd.test", since: 1 }],
    ]),
    signInsFail: false,
    signedIn: false,
    /** The last step folded, which every Timeline read gives as `through`. */
    through: 1,
    /** The Timelines of each Network, in the order they opened. */
    timelines: new Map<string, FakeTimeline[]>([["libera", []]]),
    /** Each read of a window, by its query, for a test to look at. */
    windowsRead,
  };

  /**
   * Sends one event to every follower of the changes stream.
   * @param sent - The event, as the wire carries it.
   */
  const send = (sent: typeof TimelineChangesEvent.Encoded) => {
    const id = "id" in sent ? `id: ${sent.id}\n` : "";
    const text = `event: ${sent.event}\n${id}data: ${sent.data}\n\n`;

    for (const follower of followers) {
      follower.controller.enqueue(encoder.encode(text));
    }
  };

  /** Ends every follower's stream, as a Daemon that restarts does. */
  const endStreams = () => {
    for (const follower of followers.splice(0)) {
      follower.controller.close();
    }
  };

  const signedInOnly = (answer: () => Response) =>
    daemon.signedIn ? answer() : json(401, { _tag: "Unauthorized" });

  const timelineRoute = (url: URL, init: RequestInit): Response | undefined => {
    const headers = new Headers(init.headers);

    const list = /^\/api\/networks\/(?<network>[^/]+)\/timelines$/u.exec(url.pathname)?.groups;
    const known = /^\/api\/networks\/(?<network>[^/]+)\/known$/u.exec(url.pathname)?.groups;
    const window = /^\/api\/timelines\/(?<timeline>[0-9a-f-]+)$/u.exec(url.pathname)?.groups;

    if (url.pathname === "/api/timelines/changes") {
      return signedInOnly(() => {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const follower = {
              after: url.searchParams.get("after") ?? undefined,
              controller,
              lastEventId: headers.get("last-event-id") ?? undefined,
            };

            followers.push(follower);

            // A follower that stops following is gone, as its connection would be.
            init.signal?.addEventListener("abort", () => {
              followers.splice(followers.indexOf(follower), 1);
            });
          },
        });

        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
    }

    if (list?.network !== undefined) {
      const { network } = list;

      return signedInOnly(() =>
        json(200, {
          more: false,
          projection: { _tag: "Running" },
          through: daemon.through,
          timelines: (daemon.timelines.get(network) ?? []).map((held) => held.timeline),
          version: 1,
        })
      );
    }

    if (known?.network !== undefined) {
      const session = daemon.sessions.get(known.network) ?? { _tag: "Offline", since: null };

      return signedInOnly(() =>
        json(200, { casemapping: "rfc1459", channels: [], self: null, session, users: [] })
      );
    }

    if (window?.timeline !== undefined) {
      const id = window.timeline;
      const held = [...daemon.timelines.values()].flat().find((one) => one.timeline.id === id);

      daemon.windowsRead.push(url.search);

      return signedInOnly(() =>
        held === undefined
          ? json(404, { _tag: "UnknownTimeline", timeline: id })
          : json(200, windowOf(held, url.searchParams, daemon.through))
      );
    }

    return undefined;
  };

  const answer = async (url: URL, init: RequestInit = {}): Promise<Response> => {
    const route = `${init.method ?? "GET"} ${url.pathname}`;

    switch (route) {
      case "POST /api/sign-in": {
        const { key } = Schema.decodeSync(SignInBody)(await new Response(init.body).text());

        daemon.keysSent.push(key);

        if (key !== theKey) {
          return json(401, { _tag: "Unauthorized" });
        }

        if (daemon.signInsFail) {
          return json(503, { _tag: "SignInsFailed", reason: "disk full" });
        }

        daemon.signedIn = true;

        return new Response(null, { status: 204 });
      }

      case "DELETE /api/sign-in": {
        if (daemon.signInsFail) {
          return json(503, { _tag: "SignInsFailed", reason: "disk full" });
        }

        daemon.signedIn = false;

        return new Response(null, { status: 204 });
      }

      case "GET /api/networks": {
        return signedInOnly(() =>
          json(
            200,
            [...daemon.timelines.keys()].map((network) => ({
              network,
              status: { _tag: "Running" },
            }))
          )
        );
      }

      default: {
        return timelineRoute(url, init) ?? new Response(null, { status: 404 });
      }
    }
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (daemon.down) {
      throw new TypeError("fetch failed");
    }

    const url = new URL(input instanceof Request ? input.url : input);

    // A Daemon that holds each request for the Network list until a test releases it, and
    // then answers with the Networks it holds by then.
    if (daemon.holdNetworks && url.pathname === "/api/networks") {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      daemon.networksHeld.push(() => {
        resolve(undefined);
      });
      await promise;

      return await answer(url, init);
    }

    // A Daemon that takes a follower's request and never begins its answer, until the
    // request is given up.
    if (daemon.hangChanges && url.pathname === "/api/timelines/changes") {
      const { promise, reject } = Promise.withResolvers<Response>();

      daemon.hung.push(url.searchParams.get("after") ?? "");
      init?.signal?.addEventListener("abort", () => {
        daemon.abandoned += 1;
        reject(new DOMException("aborted", "AbortError"));
      });

      return await promise;
    }

    return daemon.gatewayOnly ? new Response(null, { status: 502 }) : await answer(url, init);
  };

  return { daemon, endStreams, fetch, send };
};

/**
 * A registry whose runtime reaches the fake Daemon through `fetch`.
 * @param fetch - The fake's `fetch`.
 * @param waits - Waits other than a test's defaults, such as how long the changes stream
 * may give nothing before it is followed again.
 * @returns The registry.
 */
export const registryFor = (fetch: typeof globalThis.fetch, waits: Partial<WaitTimes> = {}) =>
  AtomRegistry.make({
    initialValues: [
      [
        runtime.layer,
        Layer.mergeAll(
          layerDaemonClient("http://daemon.test"),
          Layer.succeed(FetchHttpClient.Fetch, fetch),
          // Waits short enough for a test to see a retry or a reconnect.
          Layer.succeed(Waits, {
            idle: "2 seconds",
            longest: "50 millis",
            reconnect: "10 millis",
            retry: "10 millis",
            ...waits,
          })
        ),
      ],
    ],
  });

/**
 * Sets a command and waits until it has finished.
 * @param registry - The registry.
 * @param command - The command.
 * @param argument - Its argument.
 */
export const run = async <W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: Atom.AtomResultFn<W, A, E>,
  argument: W
) => {
  registry.set(command, argument);
  await Effect.runPromise(
    AtomRegistry.getResult(registry, command, { suspendOnWaiting: true }).pipe(Effect.ignore)
  );
};

/**
 * The values of an object's own enumerable properties, whatever they are.
 * @param value - The object.
 * @returns Its values.
 */
// oxlint-disable-next-line anti-slop/no-object-parameters -- the walk below takes values of any shape on purpose.
const ownValues = (value: object): readonly unknown[] =>
  // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
  Object.keys(value).map((key): unknown => Reflect.get(value, key));

/**
 * Whether anything reachable from a value holds a secret: a string containing it, or a
 * redacted value that still holds one containing it. It follows every own property, and
 * `Map` and `Set` entries. A DOM node is followed only through what React keeps on it, so
 * the walk stays inside React's own state and props.
 * @param from - Where to start, such as a React root or an atom registry.
 * @param secret - The secret.
 * @returns Whether it was found.
 */
// oxlint-disable-next-line anti-slop/no-object-parameters -- it starts from a React root or a registry, whose shapes are their own.
export const holds = (from: object, secret: string): boolean => {
  const seen = new Set<object>();
  const pending: unknown[] = [from];

  while (pending.length > 0) {
    const next = pending.pop();

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this walks values of any shape on purpose, looking for a string.
    if (typeof next === "string") {
      if (next.includes(secret)) {
        return true;
      }
    } else if (next instanceof Object && !seen.has(next)) {
      seen.add(next);

      if (Redacted.isRedacted(next)) {
        pending.push(hasValue(next) ? Redacted.value(next) : undefined);
      } else if (next instanceof Node) {
        pending.push(
          ...Object.keys(next)
            .filter((key) => key.startsWith("__react"))
            // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
            .map((key): unknown => Reflect.get(next, key))
        );
      } else {
        pending.push(...ownValues(next));

        if (next instanceof Map || next instanceof Set) {
          pending.push(...next.keys(), ...next.values());
        }
      }
    }
  }

  return false;
};

/**
 * Waits until an atom's value holds, reading it each time it changes.
 * @param registry - The registry.
 * @param atom - The atom.
 * @param holds - What must hold.
 * @returns The value that held, or a rejection after two seconds.
 */
export const until = async <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  holds: (value: A) => boolean
): Promise<A> => {
  const { promise, reject, resolve } = Promise.withResolvers<A>();

  const look = (value: A) => {
    if (holds(value)) {
      resolve(value);
    }
  };

  const stop = registry.subscribe(atom, look, { immediate: true });

  const timer = setTimeout(() => {
    reject(new Error("the atom never held"));
  }, 2000);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    stop();
  }
};

/**
 * Waits until something the fake holds is so, looking every few milliseconds.
 * @param holds - What must hold.
 * @returns Once it does, or a rejection after two seconds.
 */
export const eventually = async (holds: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 2000; waited += 5) {
    if (holds()) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- looking again until it holds
    await Effect.runPromise(Effect.sleep("5 millis"));
  }

  throw new Error("it never held");
};
