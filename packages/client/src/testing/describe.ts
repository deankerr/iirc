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
import type {
  Activity,
  EndReason,
  IgnoredReason,
  Named,
  News,
  Ours,
  RefusedReason,
  Where,
} from "../news.ts";
import type { Output } from "../output.ts";
import { printItem, writeInstant } from "./transcript.ts";

/**
 * Writes a string from News as one token, bare when it holds nothing a description uses
 * as syntax (a space, `"`, `=`, `@`, `:`, `;`, or `>`), and otherwise quoted as JSON, so no value can imitate an instant, an
 * attribute, or the trailing text: an id `m1@t+0s` is written `"m1@t+0s"`.
 * @param text - The string, such as a nick, a Channel, an id, or a command.
 * @returns The token.
 */
export const atom = (text: string): string =>
  /^[^\s"=@:;>]+$/u.test(text) ? text : JSON.stringify(text);

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
  ...(news.id._tag === "Unknown" ? [] : [`id=${writeFact(news.id, now, atom)}`]),
  ...(news.live === false ? ["history"] : []),
];

const writeTags = (tags: ReadonlyMap<string, string>): readonly string[] =>
  tags.size === 0
    ? []
    : [
        `tags=${[...tags]
          .map(([key, value]) => `${atom(key)}=${JSON.stringify(value)}`)
          .toSorted()
          .join(";")}`,
      ];

const writeOurs = (ours: Ours | undefined): readonly string[] =>
  ours === undefined ? [] : [`ours=${atom(ours.intent)}`, ...(ours.echo ? ["echo"] : [])];

// A key, with the name as said after it when the two differ: `#iirc`, or `#foo{:#Foo[`.
const writeNamed = ({ key, name }: Named): string =>
  key === name ? atom(key) : `${atom(key)}:${atom(name)}`;

// Each Timeline a Message or Activity touches, in order, as `in=` attributes.
const writeWhere = (where: readonly Where[]): readonly string[] =>
  where.map((each) => {
    switch (each._tag) {
      case "Network": {
        return "in=network";
      }

      case "Channel": {
        return `in=channel:${writeNamed(each)}`;
      }

      case "Direct": {
        return `in=${each.existing ? "existing-direct" : "direct"}:${writeNamed(each)}`;
      }

      case "DirectRenamed": {
        return `in=renamed:${writeNamed(each)}>${writeNamed(each.to)}`;
      }

      default: {
        return each satisfies never;
      }
    }
  });

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
      return `Malformed ${atom(reason.command)}`;
    }

    case "StaleConnection": {
      return `StaleConnection ${reason.connection}`;
    }

    case "StaleTimer": {
      return `StaleTimer ${atom(reason.timer)}`;
    }

    case "NotNow": {
      return `NotNow ${reason.input}`;
    }

    case "FeatureFailed": {
      return `FeatureFailed ${atom(reason.feature)}`;
    }

    case "Unsendable": {
      return `Unsendable ${atom(reason.command)}`;
    }

    case "Endless": {
      return `Endless ${atom(reason.command)}`;
    }

    case "UnmatchedEcho": {
      return "UnmatchedEcho";
    }

    default: {
      return reason satisfies never;
    }
  }
};

const writeRefused = (reason: RefusedReason): string =>
  reason._tag === "Rejected" ? `Rejected ${atom(reason.reply)}` : reason._tag;

const optional = (key: string, value: string | undefined, written = false): readonly string[] => {
  if (value === undefined) {
    return [];
  }

  return [`${key}=${written ? value : atom(value)}`];
};

/** An Activity's positional fields, and its trailing text, which go either side of its attributes. */
interface ActivityParts {
  readonly head: readonly string[];
  readonly tail: readonly string[];
}

// An Activity's positional fields and trailing text, before and after its attributes.
const writeActivity = (activity: Activity): ActivityParts => {
  switch (activity._tag) {
    case "Joined": {
      return { head: [atom(activity.channel), atom(activity.nick)], tail: [] };
    }

    case "Parted": {
      return {
        head: [atom(activity.channel), atom(activity.nick)],
        tail: trailing(activity.reason),
      };
    }

    case "Quit": {
      return { head: [atom(activity.nick)], tail: trailing(activity.reason) };
    }

    case "Kicked": {
      return {
        head: [atom(activity.channel), atom(activity.nick), `by=${atom(activity.by)}`],
        tail: trailing(activity.reason),
      };
    }

    case "NickChanged": {
      return { head: [atom(activity.from), atom(activity.to)], tail: [] };
    }

    case "ModeChanged": {
      return {
        head: [
          atom(activity.target),
          `by=${atom(activity.by)}`,
          ...activity.changes.map(
            (change) =>
              `${change.set ? "+" : "-"}${atom(change.mode)}${change.param === undefined ? "" : `=${atom(change.param)}`}`
          ),
        ],
        tail: [],
      };
    }

    case "TopicChanged": {
      const { topic } = activity;

      return topic === null
        ? { head: [atom(activity.channel), `by=${atom(activity.by)}`, "cleared"], tail: [] }
        : {
            head: [
              atom(activity.channel),
              `by=${atom(activity.by)}`,
              ...optional("setBy", topic.setBy),
              ...optional(
                "setAt",
                topic.setAt === undefined ? undefined : writeInstant(topic.setAt),
                true
              ),
            ],
            tail: trailing(topic.text),
          };
    }

    case "AwayChanged": {
      return activity.away === null
        ? { head: [atom(activity.nick), "back"], tail: [] }
        : { head: [atom(activity.nick)], tail: trailing(activity.away.message) };
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
      return `refused ${atom(news.intent)} ${writeRefused(news.reason)}`;
    }

    case "SessionBegan": {
      return words(["session-began", atom(news.nick), ...sessionAt(news.at, now)]);
    }

    case "SessionEnded": {
      return words(["session-ended", writeEnd(news.reason), ...sessionAt(news.at, now)]);
    }

    case "ConnectionFailed": {
      return words(["connection-failed", writeEnd(news.reason), ...sessionAt(news.at, now)]);
    }

    case "Refolded": {
      return `refolded ${news.casemapping}`;
    }

    case "Message": {
      return words([
        "message",
        news.kind,
        atom(news.sender),
        atom(news.target),
        ...attributes(news, now),
        ...writeWhere(news.where),
        ...writeTags(news.tags),
        ...writeOurs(news.ours),
        `:${news.text}`,
      ]);
    }

    case "Confirmed": {
      return words(["confirmed", atom(news.intent), ...attributes(news, now), `:${news.text}`]);
    }

    case "Activity": {
      const { head, tail } = writeActivity(news.activity);

      return words([
        "activity",
        news.activity._tag,
        ...head,
        ...attributes(news, now),
        ...writeWhere(news.where),
        ...tail,
      ]);
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
