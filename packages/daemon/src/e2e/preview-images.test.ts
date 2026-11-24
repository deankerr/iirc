/**
 * A page's image through a real Daemon: a peer on a private Ircd posts a link to a loopback
 * fixture site, the Daemon fetches the page and its `og:image` through the guard, keeps the
 * image in a private MinIO, and serves it on its own origin. Run with `bun run e2e`.
 */
import { createHash } from "node:crypto";

import { NetworkId } from "@iirc/api";
import type { TimelineItem } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { png } from "../testing/images.ts";
import { startNgircd } from "../testing/ircd.ts";
import type { Ircd } from "../testing/ircd.ts";
import { layerLoopbackLinkFetch } from "../testing/links.ts";
import { startMinio } from "../testing/minio.ts";
import type { Minio } from "../testing/minio.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually, startDaemon } from "../testing/running.ts";
import { makeKey, temporaryDirectory } from "../testing/world.ts";

vi.setConfig({ testTimeout: 60_000 });

const network = NetworkId.make("private");
const channel = "#preview-images";

let minio: Minio;
let ngircd: Ircd;

const hash = createHash("sha256").update(png).digest("hex");

/**
 * Whether a Timeline's item is a Message that holds some text.
 * @param item - The item.
 * @param text - The text.
 * @returns Whether it is.
 */
const holding = (item: TimelineItem, text: string) =>
  item.content._tag === "Message" && item.content.text.includes(text);

describe("a Preview's image through a real Daemon and MinIO", () => {
  beforeAll(async () => {
    [minio, ngircd] = await Promise.all([startMinio(), startNgircd()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([minio.stop(), ngircd.stop()]);
  });

  it("keeps a page's og:image in the bucket and serves it on the images route", async () => {
    const fixture = Bun.serve({
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        if (pathname === "/cat.png") {
          return new Response(png, { headers: { "content-type": "image/png" } });
        }

        return new Response(
          `<!doctype html><html><head><title>Cat</title><meta property="og:image" content="/cat.png"></head><body></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    const link = `http://127.0.0.1:${fixture.port}/cat`;

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const dataDir = yield* temporaryDirectory;
            const key = yield* makeKey(dataDir);

            const daemon = yield* startDaemon(
              { dataDir, linkFetch: layerLoopbackLinkFetch(fixture.port ?? 0) },
              key
            );

            const { api } = daemon;

            const send = (path: string, method: string, body?: string) =>
              Effect.promise(
                async () =>
                  await fetch(`${daemon.base}${path}`, {
                    body,
                    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                    method,
                  })
              );

            const credentials = {
              "minio-key": minio.accessKeyId,
              "minio-secret": minio.secretAccessKey,
            };

            const options = {
              "storage.s3.accessKeyId": "minio-key",
              "storage.s3.bucket": minio.bucket,
              "storage.s3.endpoint": minio.endpoint,
              "storage.s3.region": minio.region,
              "storage.s3.secretAccessKey": "minio-secret",
            };

            const held = yield* Effect.forEach(Object.entries(credentials), ([name, value]) =>
              send(`/api/credentials/${name}`, "PUT", JSON.stringify({ value }))
            );

            const set = yield* Effect.forEach(Object.entries(options), ([option, value]) =>
              send(`/api/options/${option}`, "PUT", JSON.stringify({ value }))
            );

            const on = yield* send("/api/ui/previews", "PUT", JSON.stringify({ value: "on" }));

            const peer = yield* Effect.promise(
              async () =>
                await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort })
            );

            peer.send(`JOIN ${channel}`);

            yield* api.networks.configure({
              params: { network },
              payload: configured({
                channels: [{ name: channel }],
                nicks: ["iirc"],
                servers: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
              }),
              query: {},
            });

            yield* eventually(api.networks.known({ params: { network } }), (known) =>
              known.channels.some((one) => one.name === channel && one.standing === "Joined")
            );

            peer.send(`PRIVMSG ${channel} :look ${link}`);

            const found = yield* eventually(
              Effect.gen(function* () {
                const listed = yield* api.timelines.list({ params: { network }, query: {} });
                const timeline = listed.timelines.find((one) => one.name === channel);

                if (timeline === undefined) {
                  return null;
                }

                const window = yield* api.timelines.window({
                  params: { timeline: timeline.id },
                  query: {},
                });

                const item = window.items.find((one) => holding(one, link));

                return item === undefined ? null : { item, timeline: timeline.id };
              }),
              (answer) => answer !== null
            );

            if (found === null) {
              return yield* Effect.die(new Error("the Message never arrived"));
            }

            const [preview] = yield* eventually(
              api.previews.ask({
                params: { timeline: found.timeline },
                payload: { position: found.item.position },
              }),
              (answer) => answer.previews.every((one) => one.state._tag !== "Pending")
            ).pipe(Effect.map((answer) => answer.previews));

            const served = yield* send(`/api/previews/images/${hash}`, "GET");

            const bytes = new Uint8Array(
              yield* Effect.promise(async () => await served.arrayBuffer())
            );

            peer.close();
            yield* daemon.stop;

            return {
              bytes,
              headers: Object.fromEntries(
                served.headers.entries().filter(([name]) => name !== "date")
              ),
              state: preview?.state,
              status: served.status,
              statuses: [...held, ...set, on].map((response) => response.status),
            };
          })
        )
      );

      expect(result).toStrictEqual({
        bytes: png,
        headers: {
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": String(png.length),
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": "image/png",
          etag: `"${hash}"`,
          "x-content-type-options": "nosniff",
        },
        state: {
          _tag: "Ready",
          preview: {
            description: null,
            image: {
              animated: false,
              dimensions: { height: 2, width: 2 },
              hash,
              size: png.length,
              type: "image/png",
            },
            kind: "page",
            link,
            player: null,
            site: `127.0.0.1:${fixture.port}`,
            size: null,
            stream: null,
            title: "Cat",
            type: null,
          },
        },
        status: 200,
        statuses: [204, 204, 200, 200, 200, 200, 200, 200],
      });
    } finally {
      await fixture.stop(true);
    }
  });
});
