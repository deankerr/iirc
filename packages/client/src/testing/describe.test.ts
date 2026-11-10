import { describe, expect, it } from "vitest";

import { Instant, IntentId, MessageId } from "../ids.ts";
import type { News } from "../news.ts";
import { describeNews } from "./describe.ts";
import { epoch } from "./transcript.ts";

const now = Instant.make(epoch + 1000);
const earlier = Instant.make(epoch);

const message: News = {
  _tag: "Message",
  at: { _tag: "Known", at: now, from: "receipt", value: now },
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  ours: undefined,
  sender: "peer",
  tags: new Map(),
  target: "#iirc",
  text: "hi there",
};

describe(describeNews, () => {
  it.each<readonly [News, string]>([
    [message, "message Privmsg peer #iirc :hi there"],
    [
      {
        ...message,
        at: { _tag: "Known", at: earlier, from: "ircd", value: earlier },
        id: { _tag: "Known", at: now, from: "ircd", value: MessageId.make("m1") },
        live: false,
        ours: { echo: true, intent: IntentId.make("i1") },
        tags: new Map([["+draft/reply", "m0"]]),
      },
      'message Privmsg peer #iirc at=ircd:t+0s@t+0s id=ircd:m1 history tags=+draft/reply="m0" ours=i1 echo :hi there',
    ],
    [
      {
        _tag: "Confirmed",
        at: { _tag: "Stale", since: earlier, was: earlier },
        id: { _tag: "Unknown" },
        intent: IntentId.make("i2"),
        text: "x",
      },
      "confirmed i2 at=stale:t+0s@t+0s :x",
    ],
    [
      {
        _tag: "Activity",
        activity: {
          _tag: "ModeChanged",
          by: "op",
          changes: [
            { mode: "o", param: "peer", set: true },
            { mode: "k", param: undefined, set: false },
          ],
          target: "#iirc",
        },
        at: message.at,
        id: { _tag: "Unknown" },
        live: true,
      },
      "activity ModeChanged #iirc by=op +o=peer -k",
    ],
    [
      {
        _tag: "Activity",
        activity: {
          _tag: "TopicChanged",
          by: "op",
          channel: "#iirc",
          topic: { setAt: earlier, setBy: "op", text: "a topic" },
        },
        at: message.at,
        id: { _tag: "Unknown" },
        live: true,
      },
      "activity TopicChanged #iirc by=op setBy=op setAt=t+0s :a topic",
    ],
    [
      { _tag: "SessionEnded", at: earlier, reason: { _tag: "Upgrading", port: 6697 } },
      "session-ended Upgrading 6697 at=t+0s",
    ],
    [
      { _tag: "Refused", intent: IntentId.make("i3"), reason: { _tag: "Rejected", reply: "404" } },
      "refused i3 Rejected 404",
    ],
  ])("writes %o as %j", (news, text) => {
    expect(describeNews(news, now)).toBe(text);
  });
});

describe("descriptions that cannot imitate each other", () => {
  it("tells an id known as of earlier from an id that holds an instant", () => {
    const asOfEarlier: News = {
      ...message,
      id: { _tag: "Known", at: earlier, from: "ircd", value: MessageId.make("m1") },
    };

    const holdsInstant: News = {
      ...message,
      id: { _tag: "Known", at: now, from: "ircd", value: MessageId.make("m1@t+0s") },
    };

    expect(describeNews(asOfEarlier, now)).toBe(
      "message Privmsg peer #iirc id=ircd:m1@t+0s :hi there"
    );
    expect(describeNews(holdsInstant, now)).toBe(
      'message Privmsg peer #iirc id=ircd:"m1@t+0s" :hi there'
    );
  });

  it("quotes a string from the Ircd that holds syntax", () => {
    expect(
      describeNews({ _tag: "Ignored", reason: { _tag: "Malformed", command: "MODE id=x" } }, now)
    ).toBe('ignored Malformed "MODE id=x"');
    expect(describeNews({ ...message, sender: 'a"b', target: "#a:b" }, now)).toBe(
      'message Privmsg "a\\"b" "#a:b" :hi there'
    );
  });
});

describe("an intent and its echo", () => {
  it("cannot be told from an intent whose id holds /echo", () => {
    const echoed: News = { ...message, ours: { echo: true, intent: IntentId.make("i1") } };
    const named: News = { ...message, ours: { echo: false, intent: IntentId.make("i1/echo") } };

    expect(describeNews(echoed, now)).toBe("message Privmsg peer #iirc ours=i1 echo :hi there");
    expect(describeNews(named, now)).toBe("message Privmsg peer #iirc ours=i1/echo :hi there");
  });
});
