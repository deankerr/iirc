/**
 * `message-tags`: Lines carry tags, and a Message's `msgid` is its id. Tags the Client
 * does not read are carried on the Line, and client-only tags (`+…`) are reported with
 * the Message. A Line we send may carry client-only tags, as `@iirc/protocol` allows.
 *
 * @packageDocumentation
 */
import type { Feature } from "../feature.ts";
import { CapName, FeatureName, MessageId } from "../ids.ts";

/** The `message-tags` Feature. */
export const messageTags: Feature = {
  name: FeatureName.make("message-tags"),
  needs: { caps: [CapName.make("message-tags")] },
  own: undefined,
  tags: (arrival, context) => {
    const msgid = arrival.line.tags.get("msgid");

    return {
      value:
        msgid === undefined || msgid === ""
          ? arrival
          : {
              ...arrival,
              id: { _tag: "Known", at: context.at, from: "ircd", value: MessageId.make(msgid) },
            },
    };
  },
};
