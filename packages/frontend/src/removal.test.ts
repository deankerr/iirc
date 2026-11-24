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

describe("removing a network", () => {
  it("asks first, keeping the conversations unless the Owner chooses to drop them", () => {
    const asked = after({ _tag: "Asked", keep: undefined, life: 1, network: libera });
    const dropping = reduceRemoval(asked, { _tag: "Chose", keep: false });

    expect({
      asked: removalOf(asked, "Live"),
      dropping: removalOf(dropping, "Live"),
      // `/network remove libera drop` starts on dropping them.
      started: removalOf(after({ _tag: "Asked", keep: false, life: 1, network: libera }), "Live"),
    }).toStrictEqual({
      asked: { keep: true, life: 1, network: libera },
      dropping: { keep: false, life: 1, network: libera },
      started: { keep: false, life: 1, network: libera },
    });
  });

  it("only drops the conversations of a network removed with them kept, which frees its name", () => {
    const asked = after({ _tag: "Asked", keep: true, life: 1, network: libera });

    expect({
      question: questionOf(libera, "Kept"),
      sent: removalOf(asked, "Kept"),
    }).toStrictEqual({
      question: {
        body: "libera was removed, and its conversations were kept to read. Dropping them deletes them on every device and frees the name libera for a new network.",
        choosing: false,
        confirm: "drop them",
        title: "Drop libera's conversations?",
      },
      sent: { keep: false, life: 1, network: libera },
    });
  });

  it("sends nothing when cancelled, and closes once the daemon removed it", () => {
    const cancelled = after(
      { _tag: "Asked", keep: undefined, life: 1, network: libera },
      { _tag: "Closed" }
    );

    const removed = after(
      { _tag: "Asked", keep: undefined, life: 1, network: libera },
      { _tag: "Sent" },
      { _tag: "Answered", answer: { _tag: "Removed" }, network: libera }
    );

    expect({
      cancelled: removalOf(cancelled, "Live"),
      removed,
    }).toStrictEqual({ cancelled: undefined, removed: { _tag: "Closed" } });
  });

  it("sends once, holds while in flight, and takes only its own answer", () => {
    const sending = after(
      { _tag: "Asked", keep: undefined, life: 1, network: libera },
      { _tag: "Sent" }
    );

    expect({
      again: removalOf(sending, "Live"),
      held: [
        reduceRemoval(sending, { _tag: "Closed" }),
        reduceRemoval(sending, { _tag: "Chose", keep: false }),
        reduceRemoval(sending, { _tag: "Asked", keep: undefined, life: 1, network: oftc }),
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
        { _tag: "Asked", keep: undefined, life: 1, network: libera },
        { _tag: "Sent" },
        { _tag: "Answered", answer: { _tag: "Failed", error }, network: libera }
      );

    const failures = ["UnknownNetwork", "NetworkStopped", undefined].map((error) => {
      const state = failed(error);

      return state._tag === "Asking" ? [state.failure, state.sending] : state;
    });

    expect({
      failures,
      vault: failed("VaultFailed"),
    }).toStrictEqual({
      failures: [
        ["The daemon has no network libera, so nothing was removed.", false],
        ["libera has stopped, so it cannot be removed until the daemon starts again.", false],
        [
          "The daemon did not answer, so it's unknown whether libera was removed. Removing it again is safe.",
          false,
        ],
      ],
      vault: {
        _tag: "Told",
        message:
          "libera was removed, but the daemon could not delete every password in its settings.",
        network: libera,
      },
    });
  });

  it("never claims a removal failed whose Forgotten could not be journaled, or one made from an older life", () => {
    const told = (error: string) =>
      after(
        { _tag: "Asked", keep: true, life: 1, network: libera },
        { _tag: "Sent" },
        { _tag: "Answered", answer: { _tag: "Failed", error }, network: libera }
      );

    expect({ changed: told("LifeChanged"), journal: told("JournalFailed") }).toStrictEqual({
      changed: {
        _tag: "Told",
        message:
          "libera was removed or added again since you were asked, so nothing was removed. Try again with its current state.",
        network: libera,
      },
      // The `Removed` may stand though what followed it could not be journaled.
      journal: {
        _tag: "Told",
        message:
          "The daemon could not write its history, so it's unknown whether libera was removed. The networks are reloaded to show where it stands, and if it was removed, the daemon forgets its passwords when it next starts.",
        network: libera,
      },
    });
  });
});
