import type { Tuning } from "@iirc/lifecycle/tuning";
import type { Schema } from "effect";

/** Which Network an Entry belongs to. */
export type NetworkId = string;

/** Any JSON value, which is all `session` knows of what a Change says. */
export type Json = Schema.Json;

/** Where an Ircd is reached. */
export interface Ircd {
  readonly host: string;
  /**
   * `sha256/` and the base64 SHA-256 of the key's SubjectPublicKeyInfo, as
   * `curl --pinnedpubkey` reads it. A pinned Ircd is verified by this alone (CONN-1).
   */
  readonly pin?: string;
  readonly port: number;
  readonly tls: boolean;
}

/** How a TLS Connection was secured, as its `opened` Entry records it (CONN-1). */
export interface TlsDetails {
  readonly cipher: string;
  /** The pin of the key the Ircd presented, in the form {@link Ircd.pin} takes. */
  readonly pin: string;
  readonly protocol: string;
  /** A certificate authority vouched for the Ircd's name, or its key matched the pin. */
  readonly verifiedBy: "authority" | "pin";
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
      /**
       * The names of the Credentials whose values were taken out of `bytes`, each leaving
       * `<redacted>` in its place (LOG-6). One name for each `<redacted>`, in the order they
       * stand in `bytes`, so a Credential taken out twice is named twice. Absent when
       * nothing was.
       */
      readonly redacted?: readonly string[];
      /**
       * The sequence of the Change whose `admin` key emptied `bytes`, once one has (LOG-7).
       * Only the Log sets it, after the Entry was recorded.
       */
      readonly redactedBy?: number;
    }
  | (ConnectionFields & {
      /** How many Lines the login sequence holds, `IDENTIFY` included (CONN-6). */
      readonly loginLines: number;
      /** Every nick this Connection may try, in order, so replay makes the same choices. */
      readonly nicks: readonly string[];
      readonly phase: "attempt";
      /** The rest of what the machine ran with, for the same reason as `nicks`. */
      readonly realname: string;
      /** The nicks whose `NOTICE` can be a sign of login (CONN-6). */
      readonly services: readonly string[];
      /** The whole Tuning the Connection ran with, and not just what the Owner changed. */
      readonly tuning: Tuning;
      readonly username: string;
    })
  | (ConnectionFields & {
      /** The sequence of this Connection's `attempt` Entry. */
      readonly connection: number;
      readonly phase: "opened";
      /** Absent for plaintext. */
      readonly tls?: TlsDetails;
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
      /**
       * When the Connection really ended, in epoch milliseconds, for a close recorded late
       * because the Log could not append then (LOG-9). A Gap starts here, not at `at`.
       */
      readonly endedAt?: number;
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
      /** As a Line Entry's: the Credentials taken out of `bytes` (LOG-6). */
      readonly redacted?: readonly string[];
      /** As a Line Entry's: the Change that emptied `bytes` (LOG-7). */
      readonly redactedBy?: number;
    }
  | {
      readonly _tag: "Deadline";
      readonly name: string;
      readonly network: NetworkId;
    }
  | {
      readonly _tag: "Change";
      /** The name of the key that made it, or `local` for a local command (AUTH-4). */
      readonly by: string;
      /** What changed. Only whoever records Changes reads this, never `session`. */
      readonly change: Json;
      /** The Network it concerns, if any. */
      readonly network?: NetworkId;
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
