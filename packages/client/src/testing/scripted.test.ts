import { describe, expect, it } from "vitest";

import { ConnectionId, Instant } from "../ids.ts";
import type { Input } from "../input.ts";
import { scripted } from "./scripted.ts";

const at = Instant.make(0);
const connection = ConnectionId.make(1);
const ircd = { host: "irc.test", port: 6697, tls: true };

describe("a scripted Client", () => {
  const client = scripted([
    { outputs: [{ _tag: "Dial", connection, ircd }], when: "Started" },
    { when: "Opened" },
  ]);

  it("answers each input its script expects, in order", () => {
    const started = client.step(client.initial, { _tag: "Started", at });
    const opened = client.step(started.state, { _tag: "Opened", at, connection });

    expect(started.outputs).toStrictEqual([{ _tag: "Dial", connection, ircd }]);
    expect(opened.outputs).toStrictEqual([]);
    expect(opened.state).toStrictEqual({ next: 2 });
  });

  it("ignores an input out of turn, and after its script ends", () => {
    const early: Input = { _tag: "Opened", at, connection };
    const ignored = client.step(client.initial, early);

    expect(ignored.state).toBe(client.initial);
    expect(ignored.news).toStrictEqual([
      { _tag: "Ignored", reason: { _tag: "NotNow", input: "Opened" } },
    ]);
    expect(client.step({ next: 2 }, early).outputs).toStrictEqual([]);
  });
});
