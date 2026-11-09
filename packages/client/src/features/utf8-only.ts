/**
 * `UTF8ONLY`, an ISUPPORT token: the Ircd relays only UTF-8, and takes only UTF-8. While
 * it is on, bytes are read as UTF-8 with no fallback, and nothing leaves that is not
 * UTF-8. Text the Client sends is always UTF-8, and a `Say` that cannot be is `Refused`
 * as `Unsendable` before it reaches egress. The only bytes sent as they came are a `PING`
 * token echoed in its `PONG`, so one that is not UTF-8 is sent as UTF-8 read from it.
 *
 * @packageDocumentation
 */
import { isRejected, outbound, RawParam } from "@iirc/protocol/line";
import type { Param } from "@iirc/protocol/line";
import { Schema } from "effect";

import type { Feature } from "../feature.ts";
import { FeatureName } from "../ids.ts";

const lossy = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8 = new TextEncoder();

// A parameter as UTF-8: text already is, and bytes are read as UTF-8, any that are not
// becoming U+FFFD.
const isRaw = Schema.is(RawParam);

const asUtf8 = (param: Param): Param => {
  if (!isRaw(param)) {
    return param;
  }

  const bytes = Uint8Array.from(param.bytes, (char) => char.codePointAt(0) ?? 0);
  const text = lossy.decode(bytes);
  const same = utf8.encode(text);

  return same.length === bytes.length && same.every((byte, index) => byte === bytes[index])
    ? param
    : text;
};

/** The `UTF8ONLY` Feature. */
export const utf8Only: Feature = {
  egress: (departure) => {
    const params = departure.line.params.map(asUtf8);

    if (params.every((param, index) => param === departure.line.params[index])) {
      return { value: departure };
    }

    const line = outbound(departure.line.command, params, departure.line.tags);

    return { value: isRejected(line) ? departure : { ...departure, line } };
  },
  encoding: { _tag: "Utf8Only" },
  name: FeatureName.make("utf8only"),
  needs: { tokens: ["UTF8ONLY"] },
  own: undefined,
};
