/**
 * How News and outputs read in a transcript. A `??` expectation matches a News when it
 * is exactly the text `describeNews` writes, so this is the form to write them in.
 * Defaults are left out, so the common case is short: a Message's time known by receipt
 * at the input's time, an unknown id, live, with no tags, and not ours.
 *
 * @packageDocumentation
 */
import { encode, isRejected } from "@iirc/protocol/line";

import type { Instant } from "../ids.ts";
import type { Fact } from "../known.ts";
import type { Activity, EndReason, IgnoredReason, News, Ours, RefusedReason } from "../news.ts";
import type { Output } from "../output.ts";
import { printItem, writeInstant } from "./transcript.ts";

const isAt = (fact: Fact<Instant>, now: Instant): boolean =>
  fact._tag === "Known" && fact.from === "receipt" && fact.value === now && fact.at === now;

// Writes a fact: `unknown`, `<from>:<value>` for a known one as of now, with `@<asof>`
// when it is known as of another instant, `partial:<from>:<value>`, or `stale:<was>@<since>`.
const writeFact = <T>(fact: Fact<T>, now: Instant, value: (value: T) => string): string => {
  const asOf = (at: Instant) => (at === now ? "" : `@${writeInstant(at)}`);

  switch (fact._tag) {
    case "Unknown": {
      return "unknown";
    }

    case "Known": {
      return `${fact.from}:${value(fact.value)}${asOf(fact.at)}`;
    }

    case "Partial": {
      return `partial:${fact.from}:${value(fact.atLeast)}${asOf(fact.at)}`;
    }

    case "Stale": {
      return `stale:${value(fact.was)}@${writeInstant(fact.since)}`;
    }

    default: {
      return fact satisfies never;
    }
  }
};

const trailing = (text: string | undefined): readonly string[] =>
  text === undefined ? [] : [`:${text}`];

// A Message's or an Activity's time, id, and liveness, as attributes, defaults left out.
const attributes = (
  news: { readonly at: Fact<Instant>; readonly id: Fact<string>; readonly live?: boolean },
  now: Instant
): readonly string[] => [
  ...(isAt(news.at, now) ? [] : [`at=${writeFact(news.at, now, writeInstant)}`]),
  ...(news.id._tag === "Unknown" ? [] : [`id=${writeFact(news.id, now, String)}`]),
  ...(news.live === false ? ["history"] : []),
];

const writeTags = (tags: ReadonlyMap<string, string>): readonly string[] =>
  tags.size === 0
    ? []
    : [
        `tags=${[...tags]
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .toSorted()
          .join(";")}`,
      ];

const writeOurs = (ours: Ours | undefined): readonly string[] =>
  ours === undefined ? [] : [`ours=${ours.intent}${ours.echo ? "/echo" : ""}`];

const writeEnd = (reason: EndReason): string => {
  switch (reason._tag) {
    case "Closed": {
      return `Closed ${reason.reason}`;
    }

    case "Upgrading": {
      return `Upgrading ${reason.port}`;
    }

    case "Silent":
    case "Error":
    case "LoginFailed":
    case "Disabled":
    case "Restarted": {
      return reason._tag;
    }

    default: {
      return reason satisfies never;
    }
  }
};

const writeIgnored = (reason: IgnoredReason): string => {
  switch (reason._tag) {
    case "Unparseable": {
      return `Unparseable ${reason.reason}`;
    }

    case "Malformed": {
      return `Malformed ${reason.command}`;
    }

    case "StaleConnection": {
      return `StaleConnection ${reason.connection}`;
    }

    case "StaleTimer": {
      return `StaleTimer ${reason.timer}`;
    }

    case "NotNow": {
      return `NotNow ${reason.input}`;
    }

    case "FeatureFailed": {
      return `FeatureFailed ${reason.feature}`;
    }

    default: {
      return reason satisfies never;
    }
  }
};

const writeRefused = (reason: RefusedReason): string =>
  reason._tag === "Rejected" ? `Rejected ${reason.reply}` : reason._tag;

const optional = (key: string, value: string | undefined): readonly string[] =>
  value === undefined ? [] : [`${key}=${value}`];

/** An Activity's positional fields, and its trailing text, which go either side of its attributes. */
interface ActivityParts {
  readonly head: readonly string[];
  readonly tail: readonly string[];
}

// An Activity's positional fields and trailing text, before and after its attributes.
const writeActivity = (activity: Activity): ActivityParts => {
  switch (activity._tag) {
    case "Joined": {
      return { head: [activity.channel, activity.nick], tail: [] };
    }

    case "Parted": {
      return { head: [activity.channel, activity.nick], tail: trailing(activity.reason) };
    }

    case "Quit": {
      return { head: [activity.nick], tail: trailing(activity.reason) };
    }

    case "Kicked": {
      return {
        head: [activity.channel, activity.nick, `by=${activity.by}`],
        tail: trailing(activity.reason),
      };
    }

    case "NickChanged": {
      return { head: [activity.from, activity.to], tail: [] };
    }

    case "ModeChanged": {
      return {
        head: [
          activity.target,
          `by=${activity.by}`,
          ...activity.changes.map(
            (change) =>
              `${change.set ? "+" : "-"}${change.mode}${change.param === undefined ? "" : `=${change.param}`}`
          ),
        ],
        tail: [],
      };
    }

    case "TopicChanged": {
      const { topic } = activity;

      return topic === null
        ? { head: [activity.channel, `by=${activity.by}`, "cleared"], tail: [] }
        : {
            head: [
              activity.channel,
              `by=${activity.by}`,
              ...optional("setBy", topic.setBy),
              ...optional(
                "setAt",
                topic.setAt === undefined ? undefined : writeInstant(topic.setAt)
              ),
            ],
            tail: trailing(topic.text),
          };
    }

    case "AwayChanged": {
      return activity.away === null
        ? { head: [activity.nick, "back"], tail: [] }
        : { head: [activity.nick], tail: trailing(activity.away.message) };
    }

    default: {
      return activity satisfies never;
    }
  }
};

const words = (parts: readonly string[]): string => parts.join(" ");

const sessionAt = (at: Instant, now: Instant): readonly string[] =>
  at === now ? [] : [`at=${writeInstant(at)}`];

/**
 * Writes a News as a `??` expectation's text. Instants read against the transcript's
 * clock, as `t+13s`.
 * @param news - The News.
 * @param now - The time of the input that made it, which defaults are relative to.
 * @returns Its text, such as `ignored Malformed MODE` or `message Privmsg peer #iirc :hi`.
 */
export const describeNews = (news: News, now: Instant): string => {
  switch (news._tag) {
    case "Ignored": {
      return `ignored ${writeIgnored(news.reason)}`;
    }

    case "Refused": {
      return `refused ${news.intent} ${writeRefused(news.reason)}`;
    }

    case "SessionBegan": {
      return words(["session-began", news.nick, ...sessionAt(news.at, now)]);
    }

    case "SessionEnded": {
      return words(["session-ended", writeEnd(news.reason), ...sessionAt(news.at, now)]);
    }

    case "ConnectionFailed": {
      return words(["connection-failed", writeEnd(news.reason), ...sessionAt(news.at, now)]);
    }

    case "Message": {
      return words([
        "message",
        news.kind,
        news.sender,
        news.target,
        ...attributes(news, now),
        ...writeTags(news.tags),
        ...writeOurs(news.ours),
        `:${news.text}`,
      ]);
    }

    case "Confirmed": {
      return words(["confirmed", news.intent, ...attributes(news, now), `:${news.text}`]);
    }

    case "Activity": {
      const { head, tail } = writeActivity(news.activity);

      return words(["activity", news.activity._tag, ...head, ...attributes(news, now), ...tail]);
    }

    default: {
      return news satisfies never;
    }
  }
};

/**
 * Writes an output as the transcript line that expects it. `Wake` is never written.
 * @param output - An output other than `Wake`.
 * @returns Its line, such as `>> CAP LS 302` or `-> dial irc.test:6697 tls`.
 */
export const describeOutput = (output: Exclude<Output, { readonly _tag: "Wake" }>): string => {
  switch (output._tag) {
    case "Send": {
      const bytes = encode(output.line);

      return isRejected(bytes)
        ? `>> (rejected by encode: ${bytes.reason})`
        : printItem({ _tag: "Sent", bytes: bytes.subarray(0, -2) });
    }

    case "SendSecret": {
      return printItem({ _tag: "SentSecret", line: output.line });
    }

    case "Dial": {
      return printItem({ _tag: "Dial", ...output.ircd });
    }

    case "Hangup": {
      return printItem({ _tag: "Hangup" });
    }

    default: {
      return output satisfies never;
    }
  }
};
