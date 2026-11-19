/**
 * `iirc health`: asks the Daemon whether it is well, and says so by how it exits, for a
 * container's health check or a service manager.
 *
 * @packageDocumentation
 */
import { DaemonApi } from "@iirc/api";
import type { Listen } from "@iirc/daemon";
import { Duration, Effect, Layer, Schema } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { failed, reportedOnStderr } from "./command-failed.ts";
import { ListenAddress, listenFlag } from "./listen.ts";

// The Daemon at the address asked, and nothing else: never through a proxy the
// environment names, and never where a redirect points.
const directly: BunFetchRequestInit = { proxy: false, redirect: "manual" };

const direct = Layer.provideMerge(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, directly)
);

/** How long it waits for an answer, well under a health check's own limit. */
const patience = Duration.seconds(5);

const encodeListen = Schema.encodeSync(ListenAddress);

/**
 * Where to ask a Daemon that listens at an address. A wildcard listens on every address of
 * the machine, loopback among them, so it is asked on loopback of the same family.
 * @param listen - Where it listens.
 * @returns Where to ask it.
 */
export const askedAt = ({ host, port }: Listen): Listen => {
  if (host === "0.0.0.0") {
    return { host: "127.0.0.1", port };
  }

  // Any spelling of IPv6's unspecified address, such as `::` or `0:0:0:0:0:0:0:0`.
  if (host.includes(":") && /^[0:]+$/u.test(host)) {
    return { host: "::1", port };
  }

  return { host, port };
};

export const health = Command.make(
  "health",
  { listen: listenFlag("Where the Daemon's API listens, as given to iirc daemon") },
  ({ listen }) =>
    Effect.gen(function* () {
      const address = encodeListen(askedAt(listen));

      // The one route, alone, so the client presents no key.
      const ask = yield* HttpApiClient.endpoint(DaemonApi, {
        baseUrl: `http://${address}`,
        endpoint: "health",
        group: "health",
        httpClient: yield* HttpClient.HttpClient,
      });

      yield* ask().pipe(
        Effect.timeout(patience),
        Effect.mapError((error) => {
          switch (error._tag) {
            case "Unwell": {
              return failed(
                `The Daemon at ${address} is unwell: its ${error.part} has stopped until it restarts.`
              );
            }

            case "TimeoutError": {
              return failed(`Nothing answered at ${address} within ${Duration.format(patience)}.`);
            }

            case "HttpClientError": {
              return error.reason._tag === "TransportError"
                ? failed(`Nothing answered at ${address}.`)
                : failed(`Something at ${address} answered, but not as an iirc Daemon.`);
            }

            case "InvalidRequest":
            case "SchemaError": {
              return failed(`Something at ${address} answered, but not as an iirc Daemon.`);
            }

            default: {
              return error satisfies never;
            }
          }
        })
      );
    }).pipe(Effect.provide(direct), reportedOnStderr)
).pipe(
  Command.withDescription(
    "Ask the Daemon whether it is well: exit 0 if so, and 1 with one line on stderr if not"
  )
);
