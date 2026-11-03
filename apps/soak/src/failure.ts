import type {
  Forbidden,
  InvalidMessage,
  InvalidRequest,
  LaneFull,
  LineDropped,
  LogUnavailable,
  NetworkNotFound,
  NotInSession,
  ReaderBusy,
  ReadTimedOut,
  Unauthorized,
  WriteFailed,
} from "@iirc/api";
import type { Schema } from "effect";
import type { HttpClientError } from "effect/http";

/** Everything a call through the client can fail with. */
export type Failure =
  | Forbidden
  | HttpClientError.HttpClientError
  | InvalidMessage
  | InvalidRequest
  | LaneFull
  | LineDropped
  | LogUnavailable
  | NetworkNotFound
  | NotInSession
  | ReaderBusy
  | ReadTimedOut
  | Schema.SchemaError
  | Unauthorized
  | WriteFailed;

/**
 * Puts what a call through the client can fail with in words that say what happened and
 * what to look at, for one line of a journal.
 * @param daemon - The URL of the Daemon that was asked.
 * @returns A function from the failure to its words.
 */
export const describeFailure =
  (daemon: string) =>
  (error: Failure): string => {
    switch (error._tag) {
      case "Forbidden": {
        return `the key may not do this on ${daemon} (403): it needs the ${error.needed} scope`;
      }

      case "HttpClientError": {
        return error.reason._tag === "TransportError"
          ? `could not reach the Daemon at ${daemon} (${error.message})`
          : `the Daemon at ${daemon} gave an answer this iirc-soak cannot use (${error.message})`;
      }

      case "InvalidMessage": {
        return `the Daemon refused the Message as unsafe to send (${error.reason})`;
      }

      case "InvalidRequest": {
        return `the Daemon refused the request (400): ${error.issues.map(({ message }) => message).join("; ")}`;
      }

      case "LaneFull": {
        return `the ${error.lane} lane is full, so nothing was queued (429)`;
      }

      case "LineDropped": {
        return `the Line was queued and its Connection ended before it left: ${error.reason}`;
      }

      case "LogUnavailable":
      case "ReaderBusy":
      case "ReadTimedOut": {
        return `the Daemon's Log could not be read just now (${error._tag})`;
      }

      case "NetworkNotFound": {
        return `the Daemon at ${daemon} has no such Network (404)`;
      }

      case "NotInSession": {
        return `the Network has no Session to send through (409, phase ${error.phase})`;
      }

      case "SchemaError": {
        return `the Daemon at ${daemon} gave an answer this iirc-soak cannot read (${error.message})`;
      }

      case "Unauthorized": {
        return `the Daemon at ${daemon} does not accept the key (401): it may be mistyped or revoked`;
      }

      case "WriteFailed": {
        return `the Line was recorded and its write did not finish, so it may not have reached the Ircd: ${error.reason}`;
      }

      default: {
        return error satisfies never;
      }
    }
  };
