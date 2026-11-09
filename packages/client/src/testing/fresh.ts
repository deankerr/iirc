/* oxlint-disable no-restricted-globals, no-restricted-imports -- The fresh-process check is the one part of the kit that reaches the world: it runs a child `bun` and digests what it prints. It is not run by `play` or `replay`. */
/**
 * The fresh-process replay check. Replay in one process cannot see a value seeded per
 * process, such as a hash order or a random number taken when a module loads, because
 * both folds see the same seed. This folds the same inputs in a child `bun` process and
 * compares a digest of every step's state, outputs, News, Inspection, and Knowledge.
 *
 * It is slower than `replay`, so a Client's suite runs it on a few scenarios, not all.
 *
 * @packageDocumentation
 */
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import type { Client } from "../client.ts";
import { Input } from "../input.ts";
import { canonical } from "./plain.ts";

/** Where a child process finds the Client: a module and the name it exports it by. */
export interface ClientModule {
  /** The module's path or `file:` URL, such as `new URL("./client.ts", import.meta.url)`. */
  readonly module: string | URL;
  /** The export that holds the Client. */
  readonly name: string;
}

/** A Client that folds differently in a fresh process. */
export class FreshReplayMismatchError extends Error {
  override readonly name = "FreshReplayMismatchError";
}

const pathOf = (module: string | URL): string =>
  module instanceof URL || module.startsWith("file:") ? fileURLToPath(module) : module;

const InputsJson = Schema.toCodecJson(Schema.Array(Input));

/**
 * Writes inputs as JSON, as the Journal's codec would, with bytes in base64.
 * @param inputs - The inputs.
 * @returns The JSON.
 */
const writeInputs = (inputs: readonly Input[]): string =>
  JSON.stringify(Schema.encodeSync(InputsJson)(inputs));

/**
 * Reads inputs written by {@link writeInputs}.
 * @param json - The JSON.
 * @returns The inputs, decoded.
 */
export const readInputs = (json: string): readonly Input[] =>
  Schema.decodeUnknownSync(InputsJson)(JSON.parse(json));

/**
 * Folds inputs from `initial` and digests the initial Inspection and Knowledge, and then
 * every step's state, outputs, News, Inspection, and Knowledge, in order. So even an
 * empty fold compares what the Client shows before anything has happened.
 * @param client - The Client.
 * @param inputs - The inputs.
 * @returns A SHA-256 digest, as hex.
 */
export const digest = <State>(client: Client<State>, inputs: readonly Input[]): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  let state = client.initial;
  hasher.update(`${canonical(client.inspect(state))}\n${canonical(client.known(state))}\n`);

  for (const input of inputs) {
    const step = client.step(state, input);
    ({ state } = step);
    hasher.update(
      [step.state, step.outputs, step.news, client.inspect(state), client.known(state)]
        .map((part) => `${canonical(part)}\n`)
        .join("")
    );
  }

  return hasher.digest("hex");
};

const runner = fileURLToPath(new URL("fresh-runner.ts", import.meta.url));

/**
 * Checks that a fold in a fresh `bun` process gives the same digest as one here.
 * It throws `FreshReplayMismatchError` if the digests differ, or the child fails.
 * @param client - The Client.
 * @param inputs - The inputs, such as `play(…).inputs`.
 * @param where - Where a child process can import the same Client from.
 */
export const replayFresh = async <State>(
  client: Client<State>,
  inputs: readonly Input[],
  where: ClientModule
): Promise<void> => {
  const child = Bun.spawn([process.execPath, runner, pathOf(where.module), where.name], {
    stderr: "pipe",
    stdin: new Blob([writeInputs(inputs)]),
    stdout: "pipe",
  });

  const [code, printed, failed] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (code !== 0) {
    throw new FreshReplayMismatchError(`the fresh process failed with ${code}:\n${failed}`);
  }

  const here = digest(client, inputs);

  if (printed.trim() !== here) {
    throw new FreshReplayMismatchError(
      `a fresh process folds ${inputs.length} inputs differently: ${printed.trim()} there, ${here} here. Something is seeded per process, such as a hash order or a value taken when a module loads.`
    );
  }
};
