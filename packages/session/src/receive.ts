import { takeFrames } from "@iirc/protocol/frame";

/** One inbound frame, as its Line Entry records it. */
interface Received {
  readonly bytes: Uint8Array;
  /** Longer than the limit, or what was left when the Connection ended (HOST-2). */
  readonly cut: boolean;
}

/** What a Connection has read, cut into frames, with whatever ends no frame yet held. */
export interface Receiver {
  /** The frames that `chunks` complete, in order. */
  readonly take: (chunks: readonly Uint8Array[]) => readonly Received[];
  /**
   * What was read and ends no frame, as a cut one, now that nothing more will come. It is
   * given once, and then the Receiver holds nothing.
   */
  readonly rest: () => Received | undefined;
}

/**
 * Starts framing one Connection's bytes (HOST-2). The bytes held between reads are the
 * Receiver's own, so nothing else can lose or repeat them.
 * @returns The Receiver, holding nothing.
 */
export const makeReceiver = (): Receiver => {
  let cutting = false;
  let pending: Uint8Array = new Uint8Array();

  return {
    rest: () => {
      const left = pending;

      pending = new Uint8Array();
      cutting = false;

      return left.length > 0 ? { bytes: left, cut: true } : undefined;
    },
    take: (chunks) => {
      const received: Received[] = [];

      for (const chunk of chunks) {
        const framed = takeFrames(pending, chunk, cutting);

        for (const [index, bytes] of framed.frames.entries()) {
          received.push({ bytes, cut: framed.cut.has(index) });
        }

        ({ cutting, pending } = framed);
      }

      return received;
    },
  };
};
