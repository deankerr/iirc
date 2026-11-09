/**
 * `UTF8ONLY`, an ISUPPORT token: the Ircd relays only UTF-8, and takes only UTF-8. While
 * it is on, bytes are read as UTF-8 with no fallback, and nothing leaves that is not
 * UTF-8. Text the Client sends is always UTF-8, and a `Say` that cannot be is `Refused`
 * as `Unsendable` before it reaches egress. The only bytes sent as they came are a `PING`
 * token echoed in its `PONG`, so one that is not UTF-8 is refused at egress, and not sent.
 *
 * @packageDocumentation
 */
import { RawParam } from "@iirc/protocol/line";
import type { Param } from "@iirc/protocol/line";
import { Schema } from "effect";

import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";

const strict = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8 = new TextEncoder();

const isRaw = Schema.is(RawParam);

// Whether a parameter is UTF-8: text always is, and bytes are when they read back the same.
const isUtf8 = (param: Param): boolean => {
  if (!isRaw(param)) {
    return true;
  }

  const bytes = Uint8Array.from(param.bytes, (char) => char.codePointAt(0) ?? 0);
  const same = utf8.encode(strict.decode(bytes));

  return same.length === bytes.length && same.every((byte, index) => byte === bytes[index]);
};

/** The `UTF8ONLY` Feature. */
export const utf8Only: Feature = {
  egress: (departure) => ({
    value: departure.line.params.every(isUtf8) ? departure : { _tag: "Refusal" },
  }),
  encoding: { _tag: "Utf8Only" },
  name: FeatureName.make("utf8only"),
  needs: { tokens: ["UTF8ONLY"] },
  own: undefined,
};
