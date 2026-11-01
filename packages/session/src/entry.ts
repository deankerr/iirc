/** Which Network an Entry belongs to. */
export type NetworkId = string;

/** Where an Ircd is reached. */
export interface Ircd {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
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
  | {
      readonly _tag: "Connection";
      /** The sequence of the `attempt` Entry. Absent on the `attempt` itself. */
      readonly connection?: number;
      readonly ircd: Ircd;
      readonly network: NetworkId;
      readonly phase: "attempt" | "opened" | "closed";
      readonly reason?: string;
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
