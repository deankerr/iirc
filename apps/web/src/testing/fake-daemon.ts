/**
 * What the web frontend's tests share: a fake Daemon at the `fetch` level, a registry whose
 * runtime reaches it, and ways to wait on a command and to look for a secret.
 *
 * @packageDocumentation
 */
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

import { layerDaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";

export const theKey = "iirc_the-key";

/** What the Daemon answers with, as JSON. */
type Answer =
  | Readonly<Record<string, string>>
  | readonly { readonly network: string; readonly status: Readonly<Record<string, string>> }[];

const json = (status: number, body: Answer) => Response.json(body, { status });

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

  const daemon = {
    down: false,
    gatewayOnly: false,
    keysSent,
    signInsFail: false,
    signedIn: false,
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
        return daemon.signedIn
          ? json(200, [{ network: "libera", status: { _tag: "Running" } }])
          : json(401, { _tag: "Unauthorized" });
      }

      default: {
        return new Response(null, { status: 404 });
      }
    }
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (daemon.down) {
      throw new TypeError("fetch failed");
    }

    const url = new URL(input instanceof Request ? input.url : input);

    return daemon.gatewayOnly ? new Response(null, { status: 502 }) : await answer(url, init);
  };

  return { daemon, fetch };
};

/**
 * A registry whose runtime reaches the fake Daemon through `fetch`.
 * @param fetch - The fake's `fetch`.
 * @returns The registry.
 */
export const registryFor = (fetch: typeof globalThis.fetch) =>
  AtomRegistry.make({
    initialValues: [
      [
        runtime.layer,
        Layer.merge(
          layerDaemonClient("http://daemon.test"),
          Layer.succeed(FetchHttpClient.Fetch, fetch)
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
