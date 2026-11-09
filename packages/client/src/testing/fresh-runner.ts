/* oxlint-disable no-restricted-globals, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- A child process the fresh-process check runs: it reads inputs on stdin and prints a digest. */
/**
 * Run by `replayFresh` in a child `bun` process: `bun fresh-runner.ts <module> <export>`,
 * with the inputs as JSON on stdin. It prints the digest of folding them.
 *
 * @packageDocumentation
 */
import type { Client } from "../client.ts";
import { digest, readInputs } from "./fresh.ts";

const [module, name] = Bun.argv.slice(2);

if (module === undefined || name === undefined) {
  throw new TypeError("usage: bun fresh-runner.ts <module> <export>");
}

const loaded: Readonly<Record<string, unknown>> = await import(module);

// SAFETY: the parent named this export as the Client it folded itself.
const client = loaded[name] as Client<unknown>;

process.stdout.write(`${digest(client, readInputs(await Bun.stdin.text()))}\n`);
