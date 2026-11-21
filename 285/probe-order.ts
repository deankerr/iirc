// Probe: the order the real Bun adapter sends requests to one busy name, after a scroll.
// Usage: bun order.ts <repo root>
import * as Http from "node:http";

const root = process.argv[2];
const { makeBunLinkFetch } = await import(`${root}/packages/link-fetch-bun/src/index.ts`);
const { loopbackPolicy } = await import(`${root}/packages/link-fetch/src/testing/index.ts`);
const { Effect, Stream } = await import(Bun.resolveSync("effect", `${root}/packages/link-fetch-bun/src`));

const held: Http.ServerResponse[] = [];
const seen: string[] = [];
const server = Http.createServer((request, response) => {
  seen.push(request.url ?? "");
  held.push(response);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;

const service = await Effect.runPromise(
  makeBunLinkFetch({
    policy: loopbackPolicy(port),
    resolver: { resolve: () => Effect.succeed(["127.0.0.1"]) },
    version: "probe",
  })
);

const fetching = (path: string, precedence?: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        service.fetch(`http://site.test:${port}${path}`, { kind: "page" }, precedence),
        (answer: { body: unknown }) => Stream.runDrain(answer.body)
      )
    )
  );

const tick = () => new Promise((done) => setTimeout(done, 50));
const asks: Promise<unknown>[] = [];
const ask = async (path: string, precedence?: string) => {
  asks.push(fetching(path, precedence));
  await tick();
};

// Two in flight hold the name's places while the Owner scrolls down a busy Timeline.
await ask("/in-flight-1");
await ask("/in-flight-2");
for (const n of [1, 2, 3, 4, 5, 6]) await ask(`/scrolled-past-${n}`);
await ask("/day-old-refresh", "refresh");
await ask("/oembed-of-a-begun-preview", "begun");
for (const n of [1, 2, 3]) await ask(`/on-screen-${n}`);

while (held.length > 0 || seen.length < asks.length) {
  const response = held.shift();
  response?.writeHead(200, { "content-type": "text/html" });
  response?.end("<html><head><title>x</title></head><body>");
  await tick();
}
await Promise.allSettled(asks);
server.close();
console.log(seen.map((path, at) => `${String(at + 1).padStart(2)} GET ${path}`).join("\n"));
