import { describe, expect, it } from "vitest";

import { Instant, IntentId, MessageId } from "../ids.ts";
import type { News } from "../news.ts";
import { describeNews } from "./describe.ts";
import { epoch } from "./transcript.ts";

const now = Instant.make(epoch + 1000);
const earlier = Instant.make(epoch);

const message: Extract<News, { readonly _tag: "Message" }> = {
  _tag: "Message",
  answers: undefined,
  at: { _tag: "Known", at: now, from: "receipt", value: now },
  bot: false,
  context: undefined,
  highlight: false,
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  ours: undefined,
  prefix: undefined,
  self: false,
  sender: "peer",
  tags: new Map(),
  target: "#iirc",
  text: "hi there",
  where: [{ _tag: "Channel", key: "#iirc", name: "#iirc" }],
};

describe(describeNews, () => {
  it.each<readonly [News, string]>([
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
      { _tag: "SessionEnded", at: earlier, reason: { _tag: "Upgrading", port: 6697 } },
      "session-ended Upgrading 6697 at=t+0s",
    ],
    [
      {
        _tag: "Refused",
        action: { attempted: { _tag: "Away", away: false }, where: { _tag: "Network" } },
        intent: IntentId.make("i5"),
        reason: { _tag: "Offline" },
      },
      "refused i5 Offline back in=network",
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
      "message Privmsg peer #iirc id=ircd:m1@t+0s in=channel:#iirc :hi there"
    );
    expect(describeNews(holdsInstant, now)).toBe(
      'message Privmsg peer #iirc id=ircd:"m1@t+0s" in=channel:#iirc :hi there'
    );
  });

  it("quotes a string from the Ircd that holds syntax", () => {
    expect(
      describeNews({ _tag: "Ignored", reason: { _tag: "Malformed", command: "MODE id=x" } }, now)
    ).toBe('ignored Malformed "MODE id=x"');
    expect(describeNews({ ...message, sender: 'a"b', target: "#a:b" }, now)).toBe(
      'message Privmsg "a\\"b" "#a:b" in=channel:#iirc :hi there'
    );
    expect(
      describeNews(
        {
          ...message,
          where: [{ _tag: "DirectRenamed", key: "a>b", name: "a>b", to: { key: "c", name: "c" } }],
        },
        now
      )
    ).toBe('message Privmsg peer #iirc in=renamed:"a>b">c :hi there');
  });
});

describe("an intent and its echo", () => {
  it("cannot be told from an intent whose id holds /echo", () => {
    const echoed: News = { ...message, ours: { echo: true, intent: IntentId.make("i1") } };
    const named: News = { ...message, ours: { echo: false, intent: IntentId.make("i1/echo") } };

    expect(describeNews(echoed, now)).toBe(
      "message Privmsg peer #iirc in=channel:#iirc ours=i1 echo :hi there"
    );
    expect(describeNews(named, now)).toBe(
      "message Privmsg peer #iirc in=channel:#iirc ours=i1/echo :hi there"
    );
  });
});
