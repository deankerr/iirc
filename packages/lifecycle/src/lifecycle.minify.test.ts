import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as Lifecycle from "./lifecycle.ts";
import type { Command, NetworkEvent, NetworkInput } from "./lifecycle.ts";
import { defaultTuning } from "./tuning.ts";

// The Daemon ships minified, and a Command's name comes from a function's name. If
// minification took one, the Command would vanish with nothing failing until it was
// needed, so this runs the bundle the way the release build makes it.

const input: NetworkInput = { realname: "Claude Code", tuning: defaultTuning, username: "cc" };

const attempt: NetworkEvent = { ...input, at: 1000, nicks: ["claude", "claudia"], type: "ATTEMPT" };
const opened: NetworkEvent = { at: 2000, type: "OPENED" };

const line = (command: string, ...params: readonly string[]): NetworkEvent => ({
  at: 3000,
  command,
  params,
  type: "LINE",
});

const session = [attempt, opened, line("001", "claude", "Hi")];

const run = (
  { start, step }: Pick<typeof Lifecycle, "start" | "step">,
  events: readonly NetworkEvent[]
) => {
  let snapshot = start(input);
  const commands: Command[] = [];

  for (const event of events) {
    const stepped = step(snapshot, event);

    commands.push(...stepped.commands);
    snapshot = stepped.next;
  }

  return commands;
};

const isLifecycle = (value: unknown): value is typeof Lifecycle =>
  typeof value === "object" && value !== null && "step" in value;

describe("a minified build", () => {
  const scratch = { directory: "" };

  const loadBundle = async (): Promise<typeof Lifecycle> => {
    const built = await Bun.build({
      entrypoints: [new URL("lifecycle.ts", import.meta.url).pathname],
      minify: true,
      outdir: scratch.directory,
      target: "bun",
    });

    const [output] = built.outputs;

    if (output === undefined) {
      throw new Error("The build produced nothing");
    }

    const loaded: unknown = await import(output.path);

    if (!isLifecycle(loaded)) {
      throw new Error("The build exports no machine");
    }

    return loaded;
  };

  let bundle: typeof Lifecycle;

  beforeAll(async () => {
    scratch.directory = await mkdtemp(path.join(tmpdir(), "iirc-minify-"));
    bundle = await loadBundle();
  });

  afterAll(async () => {
    await rm(scratch.directory, { force: true, recursive: true });
  });

  it("keeps every kind of Command", () => {
    const commands = run(bundle, [
      ...session,
      { at: 3000, token: Uint8Array.of(0xff), type: "PING" },
      line("376", "claude", "End"),
      { at: 4000, reason: "Owner stopped", type: "CLOSING" },
    ]);

    expect(commands).toStrictEqual([
      {
        cause: "registration",
        command: "NICK",
        lane: "control",
        params: ["claude"],
        type: "sendLine",
      },
      {
        cause: "registration",
        command: "USER",
        lane: "control",
        params: ["cc", "0", "*", "Claude Code"],
        type: "sendLine",
      },
      { cause: "ping-reply", lane: "control", token: Uint8Array.of(0xff), type: "sendPong" },
      { type: "burstComplete" },
      {
        cause: "quit",
        command: "QUIT",
        lane: "control",
        params: ["Owner stopped"],
        type: "sendLine",
      },
      { reason: "Owner stopped", type: "closeConnection" },
    ]);
  });

  it("keeps a refusal's mark", () => {
    expect(run(bundle, [attempt, opened, line("465", "*", "Banned")]).at(-1)).toStrictEqual({
      reason: "Banned",
      refused: true,
      type: "closeConnection",
    });
  });

  it("keeps the deadlines a host waits on, and their names", () => {
    const { deadline, fold } = bundle;

    expect(deadline(fold(session, input))).toStrictEqual({ at: 13_000, name: "burst" });
  });
});
