import { describe, expect, it } from "vitest";

import { replayFresh } from "./fresh.ts";
import { play, replay } from "./play.ts";
import { configured, joined, registered } from "./preludes.ts";
import { scriptedClient, seededClient, toyClient } from "./test-clients.ts";

const base = configured();
const module = new URL("test-clients.ts", import.meta.url);

describe("the fresh-process replay check", () => {
  it("passes the scripted Client", async () => {
    const played = replay(scriptedClient, {
      configuration: base,
      transcript:
        "-> dial irc.test:6697 tls\n== opened\n<< :irc.test NOTICE * :hi\n<<\\ \\xff\\x00\n",
    });

    await expect(
      replayFresh(scriptedClient, played.inputs, { module, name: "scriptedClient" })
    ).resolves.toBeUndefined();
  });

  it("passes the toy Client, with bytes, timers, and Owner inputs", async () => {
    const played = play(toyClient, {
      configuration: base,
      transcript: [
        registered(base, { caps: ["multi-prefix"] }),
        joined(base, "#iirc", ["@peer"]),
        "+60s\n>> PRIVMSG iirc ping\n",
      ],
    });

    await expect(
      replayFresh(toyClient, played.inputs, { module, name: "toyClient" })
    ).resolves.toBeUndefined();
  });

  it("catches a Client seeded once per process, which replay in one process cannot", async () => {
    const played = replay(seededClient, { configuration: base, transcript: "!! configure\n" });

    await expect(
      replayFresh(seededClient, played.inputs, { module, name: "seededClient" })
    ).rejects.toThrow(/a fresh process folds 1 inputs differently/u);
  });

  it("reports a child that cannot find the Client", async () => {
    await expect(replayFresh(toyClient, [], { module, name: "nothing" })).rejects.toThrow(
      /the fresh process failed/u
    );
  });
});
