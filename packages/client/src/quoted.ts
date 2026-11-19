/**
 * A Line written as text, as `/quote` sends it: the one rule for what may be written so,
 * which an `Act` and the Configuration's own Lines both apply. What depends on the
 * Network's state, such as a `PART` of a Channel the Configuration wants, is checked as
 * the Line is sent.
 *
 * @packageDocumentation
 */
import { isRejected, parse, quote } from "@iirc/protocol/line";
import type { Line, OutboundLine } from "@iirc/protocol/line";

const utf8 = new TextEncoder();

/**
 * Commands a Line written as text may not carry. Cap negotiation is the Client's own,
 * and an `ACK` it did not ask for is ignored, so the Ircd and the Client would disagree.
 * `PASS`, `AUTHENTICATE`, and `OPER` carry a Credential, and a Line written as text is
 * journaled as it was written. `OPER` is sent from the Configuration instead, as each
 * Session begins.
 */
const unquotable: ReadonlySet<string> = new Set(["AUTHENTICATE", "CAP", "OPER", "PASS"]);

/** A Line written as text: as it goes, and as an Ircd would read it. */
export interface Quoted {
  readonly line: OutboundLine;
  readonly read: Line;
}

/**
 * Reads a Line written as text, or refuses it. Only client-only tags may go on it, since
 * `label` and `batch` are the Client's own, which it ties answers by.
 * @param text - The Line, as written.
 * @returns The Line, or `undefined` where it may not be written so.
 */
export const quoted = (text: string): Quoted | undefined => {
  const line = quote(text);

  if (isRejected(line) || unquotable.has(line.command)) {
    return undefined;
  }

  const read = parse(utf8.encode(text), { _tag: "Utf8Only" });

  if (read._tag === "Unparseable" || !Object.keys(line.tags).every((key) => key.startsWith("+"))) {
    return undefined;
  }

  return { line, read: read.line };
};
