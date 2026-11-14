import { NetworkId } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { initialRemoval, questionOf, reduceRemoval, removalOf } from "./removal.ts";
import type { Removal, RemovalEvent } from "./removal.ts";

const libera = Schema.decodeSync(NetworkId)("libera");
const oftc = Schema.decodeSync(NetworkId)("oftc");

const after = (...events: readonly RemovalEvent[]): Removal => {
  let state = initialRemoval;

  for (const event of events) {
    state = reduceRemoval(state, event);
  }

  return state;
};

describe("removing a Network", () => {
  it("asks first, keeping the Timelines unless the Owner chooses to drop them", () => {
    const asked = after({ _tag: "Asked", keep: undefined, network: libera });
    const dropping = reduceRemoval(asked, { _tag: "Chose", keep: false });

    expect({
      asked: removalOf(asked, "Live"),
      dropping: removalOf(dropping, "Live"),
      // `/network remove libera drop` starts on dropping them.
      started: removalOf(after({ _tag: "Asked", keep: false, network: libera }), "Live"),
    }).toStrictEqual({
      asked: { keep: true, network: libera },
      dropping: { keep: false, network: libera },
      started: { keep: false, network: libera },
    });
  });

  it("only drops the Timelines of a Network removed with them kept, which frees its name", () => {
    const asked = after({ _tag: "Asked", keep: true, network: libera });

    expect({
      question: questionOf(libera, "Kept"),
      sent: removalOf(asked, "Kept"),
    }).toStrictEqual({
      question: {
        body: "libera was removed, and its Timelines were kept to read. Dropping them deletes them for every Frontend, and lets a new Network take the name libera.",
        choosing: false,
        confirm: "Drop them",
        title: "Drop libera's Timelines?",
      },
      sent: { keep: false, network: libera },
    });
  });

  it("sends nothing when cancelled, and closes once the Daemon removed it", () => {
    const cancelled = after(
      { _tag: "Asked", keep: undefined, network: libera },
      { _tag: "Closed" }
    );

    const removed = after(
      { _tag: "Asked", keep: undefined, network: libera },
      { _tag: "Sent" },
      { _tag: "Answered", answer: { _tag: "Removed" }, network: libera }
    );

    expect({
      cancelled: removalOf(cancelled, "Live"),
      removed,
    }).toStrictEqual({ cancelled: undefined, removed: { _tag: "Closed" } });
  });

  it("sends once, holds while in flight, and takes only its own answer", () => {
    const sending = after({ _tag: "Asked", keep: undefined, network: libera }, { _tag: "Sent" });

    expect({
      again: removalOf(sending, "Live"),
      held: [
        reduceRemoval(sending, { _tag: "Closed" }),
        reduceRemoval(sending, { _tag: "Chose", keep: false }),
        reduceRemoval(sending, { _tag: "Asked", keep: undefined, network: oftc }),
        reduceRemoval(sending, {
          _tag: "Answered",
          answer: { _tag: "Removed" },
          network: oftc,
        }),
      ].every((one) => one === sending),
    }).toStrictEqual({ again: undefined, held: true });
  });

  it("says why it failed, from the error's tag, and lets it be sent again", () => {
    const failed = (error: string | undefined) =>
      after(
        { _tag: "Asked", keep: undefined, network: libera },
        { _tag: "Sent" },
        { _tag: "Answered", answer: { _tag: "Failed", error }, network: libera }
      );

    const failures = ["UnknownNetwork", "NetworkStopped", "JournalFailed", undefined].map(
      (error) => {
        const state = failed(error);

        return state._tag === "Asking" ? [state.failure, state.sending] : state;
      }
    );

    expect({
      failures,
      vault: failed("VaultFailed"),
    }).toStrictEqual({
      failures: [
        ["The Daemon has no Network libera, so nothing was removed.", false],
        ["libera has stopped, so it cannot be removed until the Daemon starts again.", false],
        ["The Daemon could not write its Journal, so libera was not removed.", false],
        [
          "The Daemon did not answer, so whether libera was removed is unknown. Removing it again is safe.",
          false,
        ],
      ],
      vault: {
        _tag: "Told",
        message:
          "libera was removed, but the Daemon could not forget every Credential its Configuration named.",
        network: libera,
      },
    });
  });

  it("holds only plain data, which survives structuredClone", () => {
    const state = after({ _tag: "Asked", keep: false, network: libera });

    expect(structuredClone(state)).toStrictEqual(state);
  });
});
