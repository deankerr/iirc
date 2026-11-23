/**
 * Reading and closing a Timeline already resolved: a projection names it by its kind, key,
 * and name rather than by a Target, so the Client parses nothing and needs no `CHANTYPES`.
 * Otherwise it is taken as a Target's is: a Read Marker moves only forward, the Network's
 * own is never closed, and a Channel Self is in stays open.
 */
import { describe, expect, it } from "vitest";

import type { Step } from "../client.ts";
import { client } from "../core.ts";
import { Instant } from "../ids.ts";
import type { ClientState } from "../index.ts";
import type { Input } from "../input.ts";
import {
  configured,
  describeNews,
  epoch,
  floorIsupport,
  joined,
  play,
  registered,
} from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const at = Instant.make(epoch + 60_000);

const instant = (seconds: number) => Instant.make(epoch + seconds * 1000);

// Steps each input in turn after a prelude, and gives every News of those steps as `??`
// writes it.
const after = (state: ClientState, inputs: readonly Input[]) => {
  const news: string[] = [];
  let now = state;

  for (const input of inputs) {
    const step: Step<ClientState> = client.step(now, input);

    now = step.state;
    news.push(...step.news.map((one) => describeNews(one, Instant.make(epoch))));
  }

  return { news, state: now };
};

const read = (target: Extract<Input, { readonly _tag: "Read" }>["target"], seconds: number) =>
  ({ _tag: "Read", at, read: instant(seconds), target }) as const;

const close = (target: Extract<Input, { readonly _tag: "CloseTimeline" }>["target"]) =>
  ({ _tag: "CloseTimeline", at, target }) as const;

const iirc = { _tag: "Channel", key: "#iirc", name: "#IIRC" } as const;

describe("a Timeline already resolved", () => {
  it("is read as its Target is, with the same News, and only forward", () => {
    const { state } = play(client, {
      configuration: base,
      transcript: [registered(base), joined(base, "#iirc", ["peer"])],
    });

    const byTarget = after(state, [read("#IIRC", 5), read("#IIRC", 3), read("#IIRC", 8)]);
    const resolved = after(state, [read(iirc, 5), read(iirc, 3), read(iirc, 8)]);

    expect(resolved.news).toStrictEqual(byTarget.news);
    expect(resolved.news).toStrictEqual([
      "read-marker t+5s in=channel:#iirc:#IIRC",
      "read-marker t+8s in=channel:#iirc:#IIRC",
    ]);
  });

  it("shares one Read Marker with its Target, so neither moves it back", () => {
    const { state } = play(client, {
      configuration: base,
      transcript: [registered(base)],
    });

    const { news } = after(state, [
      read("Peer", 5),
      read({ _tag: "Direct", key: "peer", name: "peer" }, 4),
      read({ _tag: "Direct", key: "peer", name: "peer" }, 6),
      read("peer", 6),
      read({ _tag: "Network" }, 2),
      read(null, 1),
    ]);

    expect(news).toStrictEqual([
      "read-marker t+5s in=existing-direct:peer:Peer",
      "read-marker t+6s in=existing-direct:peer",
      "read-marker t+2s in=network",
    ]);
  });

  it("never closes the Network's own, nor a Channel Self is in", () => {
    const { state } = play(client, {
      configuration: base,
      transcript: [registered(base), joined(base, "#iirc", ["peer"])],
    });

    const { news } = after(state, [
      close({ _tag: "Network" }),
      close(iirc),
      close({ _tag: "Channel", key: "#elsewhere", name: "#elsewhere" }),
      close({ _tag: "Direct", key: "peer", name: "Peer" }),
    ]);

    expect(news).toStrictEqual([
      "ignored NoTimeline",
      "ignored Joined #IIRC",
      "timeline-closed in=channel:#elsewhere",
      "timeline-closed in=existing-direct:peer:Peer",
    ]);
  });

  it("names a Channel only CHANTYPES made one, while the Network is offline", () => {
    const { state } = play(client, {
      configuration: base,
      transcript: [
        registered(base, {
          isupport: floorIsupport.map((token) =>
            token === "CHANTYPES=#" ? "CHANTYPES=#+" : token
          ),
        }),
        lines("== closed Reset"),
      ],
    });

    const other = { _tag: "Channel", key: "+other", name: "+other" } as const;

    const { news } = after(state, [read("+other", 5), read(other, 5), close(other)]);

    expect(news).toStrictEqual([
      "ignored NoTimeline",
      "read-marker t+5s in=channel:+other",
      "timeline-closed in=channel:+other",
    ]);
  });
});
