/** Which Network an Entry belongs to. */
export type NetworkId = string;

/** Where an Ircd is reached. */
export interface Ircd {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
}

interface ConnectionFields {
  readonly _tag: "Connection";
  readonly ircd: Ircd;
  readonly network: NetworkId;
}

/** An Entry before the Log has numbered it. */
export type NewEntry =
  | {
      readonly _tag: "Line";
      readonly bytes: Uint8Array;
      /** Why an outbound Line was sent, such as `ping-reply`. Absent when inbound. */
      readonly cause?: string;
      /** The sequence of this Connection's `attempt` Entry. */
      readonly connection: number;
      /** The frame was longer than the limit and was cut. */
      readonly cut?: boolean;
      readonly direction: "inbound" | "outbound";
      readonly network: NetworkId;
    }
  | (ConnectionFields & {
      /** Every nick this Connection may try, in order, so replay makes the same choices. */
      readonly nicks: readonly string[];
      readonly phase: "attempt";
    })
  | (ConnectionFields & {
      /** The sequence of this Connection's `attempt` Entry. */
      readonly connection: number;
      readonly phase: "opened";
    })
  | (ConnectionFields & {
      /** The sequence of this Connection's `attempt` Entry. */
      readonly connection: number;
      /** The Daemon chose to leave (LIVE-9), so however this ends, it is not a failure. */
      readonly chosen: boolean;
      readonly phase: "closing";
      /** Why the Daemon is ending this Connection, and the `QUIT` reason when it chose to. */
      readonly reason: string;
    })
  | (ConnectionFields & {
      /** The sequence of this Connection's `attempt` Entry. */
      readonly connection: number;
      readonly phase: "closed";
      readonly reason?: string;
      /** The Network does not want us, so backoff is at least LIVE-5's. */
      readonly refused?: true;
    })
  | {
      readonly _tag: "Dropped";
      /** The Line that was never written, or as much of it as could be built. */
      readonly bytes: Uint8Array;
      /** Why it was going to be sent, as a Line Entry would have said. */
      readonly cause: string;
      /** The sequence of this Connection's `attempt` Entry. */
      readonly connection: number;
      readonly network: NetworkId;
      /** Why it was not sent. */
      readonly reason: string;
    }
  | {
      readonly _tag: "Deadline";
      readonly name: string;
      readonly network: NetworkId;
    }
  | {
      readonly _tag: "Daemon";
      readonly phase: "started" | "stopped";
      readonly version: string;
    };

/** An Entry as the Log holds it. `at` is epoch milliseconds when it was recorded. */
export type Entry = NewEntry & {
  readonly at: number;
  readonly sequence: number;
};
