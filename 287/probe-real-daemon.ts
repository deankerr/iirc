/**
 * Probe for #287, not committed: a real Daemon on ngircd, fetching a loopback site's files
 * through the guard, and printing each Preview's state. PROBE_HOLD=<file> keeps the
 * Daemon on 127.0.0.1:7667 until the file exists, for the web frontend to show.
 */
import { existsSync, writeFileSync } from "node:fs";

import { DaemonApi, NetworkId } from "@iirc/api";
import { configured } from "@iirc/client/testing";
import { Context, Effect, Layer, Schedule } from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { it, vi } from "vitest";

import { layerDaemon } from "../daemon.ts";
import { startNgircd } from "../testing/ircd.ts";
import { layerLoopbackLinkFetch } from "../testing/links.ts";
import { connectPeer } from "../testing/peer.ts";
import { eventually } from "../testing/running.ts";
import { makeKey, presenting, temporaryDirectory } from "../testing/world.ts";

vi.setConfig({ testTimeout: 3_600_000 });

const network = NetworkId.make("private");
const channel = "#previews";
const hold = process.env.PROBE_HOLD;

it("probes", async () => {
  const ngircd = await startNgircd();

  const fixture = Bun.serve({
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      const html = (status: number, head: string) =>
        new Response(`<!doctype html><html><head>${head}</head><body>${head}</body></html>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status,
        });

      switch (pathname) {
        case "/files/quarterly-report.pdf": {
          const pdf = new Uint8Array(48_213).fill(0x20);
          pdf.set(new TextEncoder().encode("%PDF-1.7\n"));
          return new Response(pdf, { headers: { "content-type": "application/pdf" } });
        }
        case "/files/release-notes.txt": {
          return new Response(
            "iirc 0.9 release notes\r\n\r\n- Previews of files: a PDF shows its type and size.\r\n- A text file shows its first lines, <b>never</b> as markup.\r\n    Indented lines keep their indent.\r\n",
            { headers: { "content-type": "text/plain; charset=utf-8" } }
          );
        }
        case "/files/empty.txt": {
          return new Response("", { headers: { "content-type": "text/plain" } });
        }
        default: {
          return html(200, '<title>Cats</title><meta name="description" content="All about cats.">');
        }
      }
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  const site = `http://127.0.0.1:${fixture.port}`;
  const first = `${site}/files/quarterly-report.pdf ${site}/files/release-notes.txt ${site}/files/empty.txt`;
  const second = `${site}/ok`;

  try {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* temporaryDirectory;
          const key = yield* makeKey(dataDir);

          const context = yield* Layer.build(
            layerDaemon(
              { dataDir, linkFetch: layerLoopbackLinkFetch(fixture.port ?? 0) },
              { host: "127.0.0.1", port: hold === undefined ? 0 : 7667 }
            )
          );

          const { address } = Context.get(context, HttpServer.HttpServer);
          const base =
            address._tag === "UnixPathAddress" ? "" : `http://127.0.0.1:${address.port}`;

          const api = yield* HttpApiClient.make(DaemonApi, { baseUrl: base }).pipe(
            Effect.provide(Layer.merge(presenting(key), FetchHttpClient.layer))
          );

          yield* Effect.promise(
            async () =>
              await fetch(`${base}/api/ui/previews`, {
                body: JSON.stringify({ value: "text" }),
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                method: "PUT",
              })
          );

          const peer = yield* Effect.promise(
            async () => await connectPeer({ host: ngircd.host, nick: "peer", port: ngircd.plainPort })
          );

          peer.send(`JOIN ${channel}`);

          yield* api.networks.configure({
            params: { network },
            payload: configured({
              channels: [{ name: channel }],
              ircds: [{ host: ngircd.host, port: ngircd.plainPort, tls: false }],
              nicks: ["iirc"],
            }),
            query: {},
          });

          yield* eventually(api.networks.known({ params: { network } }), (known) =>
            known.channels.some((one) => one.name === channel && one.standing === "Joined")
          );

          peer.send(`PRIVMSG ${channel} :${first}`);
          peer.send(`PRIVMSG ${channel} :${second}`);

          const timeline = yield* eventually(
            api.timelines.list({ params: { network }, query: {} }).pipe(
              Effect.map((listed) => listed.timelines.find((one) => one.name === channel))
            ),
            (found) => found !== undefined
          );

          const id = timeline?.id ?? "";

          const window = yield* eventually(
            api.timelines.window({ params: { timeline: id }, query: {} }),
            (answer) => answer.items.filter((one) => one.content._tag === "Message").length >= 2
          );

          const states = [];

          for (const item of window.items.filter((one) => one.content._tag === "Message")) {
            const answer = yield* eventually(
              api.previews.ask({ params: { timeline: id }, payload: { position: item.position } }),
              (asked) => asked.previews.every((one) => one.state._tag !== "Pending")
            );

            for (const one of answer.previews) {
              states.push({ link: one.link.replace(site, "H"), state: one.state });
            }
          }

          if (hold !== undefined) {
            writeFileSync(`${hold}.key`, key);
            yield* Effect.sync(() => existsSync(hold)).pipe(
              Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (done) => done })
            );
          }

          peer.close();

          return states;
        })
      )
    );

    // oxlint-disable-next-line no-console -- a probe prints what it saw
    writeFileSync(process.env.PROBE_OUT ?? "/dev/null", JSON.stringify(out, null, 2));
  } finally {
    await fixture.stop(true);
    await ngircd.stop();
  }
});
