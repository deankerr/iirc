/**
 * A Feature turning off mid-Session: the facts only it kept go stale, and each Joined
 * Channel whose members' facts changed is reported learned, once, so a Frontend reading
 * its members reads them again.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";

const base = configured();

const bot = [...floorIsupport, "BOT=B"];

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// The Channels reported learned by the steps the last transcript item played, sorted.
const learnedBy = (transcript: readonly string[]): readonly string[] => {
  const before = play(client, { configuration: base, transcript: transcript.slice(0, -1) });
  const after = play(client, { configuration: base, transcript });

  return after.steps
    .slice(before.steps.length)
    .flatMap((step) => step.news)
    .flatMap((news) => (news._tag === "ChannelLearned" ? [news.channel.key] : []))
    .toSorted();
};

describe("a Feature turning off reports the Channels whose members' facts went stale", () => {
  // Catches an open members list that keeps showing a `bot` mark after `BOT` is taken back.
  it("names the Channel of a member whose bot mark was known, when BOT is taken back", () => {
    expect(
      learnedBy([
        registered(base, { isupport: bot, offered: ["message-tags"] }),
        joined(base, "#iirc", ["robo"]),
        lines("<< @bot :robo!u@h PRIVMSG #iirc :beep"),
        lines("<< :irc.test 005 iirc -BOT :are supported by this server"),
      ])
    ).toStrictEqual(["#iirc"]);
  });

  // Catches an open members list that keeps showing an account after `CAP DEL`.
  it("names the Channels of a member whose account was known, on CAP DEL of account-notify", () => {
    expect(
      learnedBy([
        registered(base, { offered: ["cap-notify", "account-notify"] }),
        joined(base, "#iirc", ["peer"]),
        joined(base, "#two", ["peer"]),
        joined(base, "#quiet", ["other"]),
        lines("<< :peer!u@h ACCOUNT bob"),
        lines("<< :irc.test CAP iirc DEL :account-notify"),
      ])
    ).toStrictEqual(["#iirc", "#two"]);
  });

  // Catches a Channel reported once per member or per fact that went stale in it. Self is a
  // member of each, and Self's own mark was known from joining.
  it("names each Channel once, however many of its members' facts went stale", () => {
    expect(
      learnedBy([
        registered(base, { isupport: bot, offered: ["message-tags"] }),
        joined(base, "#iirc", ["robo", "droid"]),
        joined(base, "#other", ["robo"]),
        lines("<< @bot :robo!u@h PRIVMSG #iirc :beep", "<< @bot :droid!u@h PRIVMSG #iirc :boop"),
        lines("<< :irc.test 005 iirc -BOT :are supported by this server"),
      ])
    ).toStrictEqual(["#iirc", "#other"]);
  });

  // Catches a report made for every Joined Channel whenever a Feature turns off.
  it("names none when no fact the Feature kept was known", () => {
    expect(
      learnedBy([
        registered(base, { offered: ["cap-notify", "account-notify"] }),
        joined(base, "#iirc", ["peer"]),
        lines("<< :irc.test CAP iirc DEL :account-notify"),
      ])
    ).toStrictEqual([]);
  });

  // Catches a report made by a Feature turning on, which makes no fact stale.
  it("names none when a Feature turns on", () => {
    expect(
      learnedBy([
        registered(base, { offered: ["message-tags"] }),
        joined(base, "#iirc", ["robo"]),
        lines("<< :irc.test 005 iirc BOT=B :are supported by this server"),
      ])
    ).toStrictEqual([]);
  });

  // Catches Self's own fact going stale unreported where a listing left Self out, though
  // Self is in every Channel it is joined to.
  it("names every Joined Channel when only Self's fact went stale", () => {
    expect(
      learnedBy([
        registered(base, { isupport: bot }),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :iirc!~iirc@iirc.test JOIN #iirc",
          ">> MODE #iirc",
          "<< :irc.test 353 iirc = #iirc :peer",
          "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
          "<< :iirc!~iirc@iirc.test MODE iirc +B"
        ),
        lines("<< :irc.test 005 iirc -BOT :are supported by this server"),
      ])
    ).toStrictEqual(["#iirc"]);
  });
});
