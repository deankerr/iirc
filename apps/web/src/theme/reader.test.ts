import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { workerThemeReader } from "./reader.ts";
import type { ReaderWorker } from "./reader.ts";

const unreadable = {
  _tag: "Invalid",
  message: "Theme files cannot be read in this browser, so nothing was imported.",
};

/**
 * A stand-in Worker that answers each text as `answer` says, and keeps whether it ended.
 * @param answer - What it does once sent a text: fire an event of a type, with data.
 * @returns The Worker, and whether it was terminated.
 */
const standIn = (answer: {
  readonly type: "message" | "error" | "messageerror";
  readonly data?: unknown;
}) => {
  const listeners = new Map<string, (event: Event) => void>();
  const state = { terminated: false };

  const worker: ReaderWorker = {
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    postMessage: () => {
      queueMicrotask(() => {
        listeners.get(answer.type)?.(
          answer.type === "message"
            ? new MessageEvent("message", { data: answer.data })
            : new Event(answer.type)
        );
      });
    },
    terminate: () => {
      state.terminated = true;
    },
  };

  return { state, worker };
};

/**
 * What a reader over Workers from `start` reads `text` as.
 * @param start - Starts a Worker.
 * @returns What it read.
 */
const readWith = async (start: () => ReaderWorker) =>
  await Effect.runPromise(workerThemeReader(start).read("text"));

describe("the browser's reader of themes", () => {
  it("answers in words, never a defect, when no Worker can start, or one fails", async () => {
    const failing = standIn({ type: "error" });
    const garbled = standIn({ type: "messageerror" });
    const nonsense = standIn({ data: { _tag: "Parsed", value: 1 }, type: "message" });
    const read = { _tag: "Invalid", message: "This is not a theme." } as const;
    const answering = standIn({ data: read, type: "message" });

    expect({
      answered: await readWith(() => answering.worker),
      failed: await readWith(() => failing.worker),
      garbled: await readWith(() => garbled.worker),
      nonsense: await readWith(() => nonsense.worker),
      terminated: [failing, garbled, nonsense, answering].map((one) => one.state.terminated),
      throws: await readWith(() => {
        throw new DOMException("refused", "SecurityError");
      }),
    }).toStrictEqual({
      answered: read,
      failed: unreadable,
      garbled: unreadable,
      nonsense: unreadable,
      terminated: [true, true, true, true],
      throws: unreadable,
    });
  });
});
