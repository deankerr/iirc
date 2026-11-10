import { describe, expect, it } from "vitest";

import { Instant, IntentId, MessageId } from "../ids.ts";
import type { News } from "../news.ts";
import { describeNews } from "./describe.ts";
import { epoch } from "./transcript.ts";

const now = Instant.make(epoch + 1000);
const earlier = Instant.make(epoch);

const message: Extract<News, { readonly _tag: "Message" }> = {
  _tag: "Message",
  at: { _tag: "Known", at: now, from: "receipt", value: now },
  highlight: false,
  id: { _tag: "Unknown" },
  kind: "Privmsg",
  live: true,
  ours: undefined,
  sender: "peer",
  tags: new Map(),
  target: "#iirc",
  text: "hi there",
  where: [{ _tag: "Channel", key: "#iirc", name: "#iirc" }],
};

describe(describeNews, () => {
  it.each<readonly [News, string]>([
    [message, "message Privmsg peer #iirc in=channel:#iirc :hi there"],
    [
      { ...message, highlight: true },
      "message Privmsg peer #iirc highlight in=channel:#iirc :hi there",
    ],
    [
      {
        _tag: "ReadMarker",
        read: earlier,
        where: { _tag: "Direct", existing: true, key: "peer", name: "Peer" },
      },
      "read-marker t+0s in=existing-direct:peer:Peer",
    ],
    [{ _tag: "ReadMarker", read: now, where: { _tag: "Network" } }, "read-marker t+1s in=network"],
    [{ _tag: "Ignored", reason: { _tag: "NoTimeline" } }, "ignored NoTimeline"],
    [
      {
        ...message,
        at: { _tag: "Known", at: earlier, from: "ircd", value: earlier },
        id: { _tag: "Known", at: now, from: "ircd", value: MessageId.make("m1") },
        live: false,
        ours: { echo: true, intent: IntentId.make("i1") },
        tags: new Map([["+draft/reply", "m0"]]),
      },
      'message Privmsg peer #iirc at=ircd:t+0s@t+0s id=ircd:m1 history in=channel:#iirc tags=+draft/reply="m0" ours=i1 echo :hi there',
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
        where: [{ _tag: "Channel", key: "#iirc", name: "#iirc" }],
      },
      "activity ModeChanged #iirc by=op +o=peer -k in=channel:#iirc",
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
        where: [{ _tag: "Channel", key: "#foo{", name: "#Foo[" }],
      },
      "activity TopicChanged #iirc by=op setBy=op setAt=t+0s in=channel:#foo{:#Foo[ :a topic",
    ],
    [
      {
        _tag: "Activity",
        activity: { _tag: "NickChanged", from: "Peer", to: "pal" },
        at: message.at,
        id: { _tag: "Unknown" },
        live: true,
        where: [
          { _tag: "Channel", key: "#iirc", name: "#iirc" },
          {
            _tag: "DirectRenamed",
            key: "peer",
            name: "Peer",
            to: { key: "pal", name: "pal" },
          },
        ],
      },
      "activity NickChanged Peer pal in=channel:#iirc in=renamed:peer:Peer>pal",
    ],
    [
      {
        _tag: "Activity",
        activity: { _tag: "AwayChanged", away: null, nick: "peer" },
        at: message.at,
        id: { _tag: "Unknown" },
        live: true,
        where: [{ _tag: "Direct", existing: true, key: "peer", name: "peer" }],
      },
      "activity AwayChanged peer back in=existing-direct:peer",
    ],
    [
      {
        ...message,
        target: "iirc",
        where: [{ _tag: "Direct", existing: false, key: "peer", name: "peer" }],
      },
      "message Privmsg peer iirc in=direct:peer :hi there",
    ],
    [
      { ...message, target: "$*", where: [{ _tag: "Network" }] },
      "message Privmsg peer $* in=network :hi there",
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
