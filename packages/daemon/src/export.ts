/**
 * A Timeline exported as plain text: one line an item, each with its time, and the name of
 * the file it is given as. Every name and word in it came from a Network, so formatting is
 * stripped and no control character is left, and each item is exactly one line that
 * nothing can drive a terminal with.
 *
 * @packageDocumentation
 */
import type { Activity, Attempted, CloseReason, EndReason } from "@iirc/client";
import { stripFormatting } from "@iirc/protocol/format";
import type { Item, Summary } from "@iirc/timeline-store";
import type { Content } from "@iirc/timelines";

// C0 and C1 controls, DEL, and the Unicode line and paragraph separators, which would
// break a line or drive a terminal, and bidirectional controls, which would reorder it.
const controls = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu;

/**
 * Text from a Network as it is written out: its formatting stripped, and every control
 * character left a space.
 * @param text - The text.
 * @returns The text, on one line.
 */
const plain = (text: string): string => stripFormatting(text).replaceAll(controls, " ");

/**
 * An instant as `Date.prototype.toISOString` writes it, in UTC to the millisecond, so the
 * lines sort as text. One beyond what a `Date` holds is written as its number.
 * @param at - Milliseconds since the Unix epoch.
 * @returns The time.
 */
const timeOf = (at: number): string => {
  const date = new Date(at);

  return Number.isNaN(date.getTime()) ? String(at) : date.toISOString();
};

const because = (reason: string | undefined): string =>
  reason === undefined || reason === "" ? "" : ` (${plain(reason)})`;

const closeReasons: Readonly<Record<CloseReason, string>> = {
  Ended: "the Ircd closed the connection",
  HungUp: "we hung up",
  Refused: "the connection was refused",
  Reset: "the connection was reset",
  TimedOut: "the connection timed out",
  Tls: "TLS failed",
  Unreachable: "the Ircd could not be reached",
};

const endReason = (reason: EndReason): string => {
  switch (reason._tag) {
    case "Closed": {
      return closeReasons[reason.reason];
    }

    case "Disabled": {
      return "the Network was disabled";
    }

    case "Error": {
      return "the Ircd sent ERROR";
    }

    case "LoginFailed": {
      return "logging in failed";
    }

    case "Restarted": {
      return "the Daemon restarted";
    }

    case "Silent": {
      return "the Ircd stopped answering";
    }

    case "Upgrading": {
      return `upgrading to TLS on port ${reason.port}`;
    }

    default: {
      return reason satisfies never;
    }
  }
};

const unanswered = {
  History: "from history",
  Limited: "too many requests",
  Off: "answers are off",
  Unknown: "not understood",
  Unreachable: "no one to answer",
  Unsendable: "too long to send",
} as const;

const ctcp = (command: string, args: string, between: string): string =>
  args === "" ? plain(command) : `${plain(command)}${between}${plain(args)}`;

type Movement = Extract<
  Activity,
  {
    readonly _tag: "Joined" | "CameOnline" | "Parted" | "Quit" | "Kicked" | "WentOffline";
  }
>;

const isMovement = (activity: Activity): activity is Movement =>
  activity._tag === "Joined" ||
  activity._tag === "CameOnline" ||
  activity._tag === "Parted" ||
  activity._tag === "Quit" ||
  activity._tag === "Kicked" ||
  activity._tag === "WentOffline";

/**
 * A User coming or going, marked `-->` for a join or a partner coming online, and `<--` for
 * a part, a quit, a kick, or a partner going offline.
 * @param activity - The Activity.
 * @returns Its marker and words.
 */
const movementText = (activity: Movement): string => {
  switch (activity._tag) {
    case "Joined": {
      return `--> ${plain(activity.nick)} joined ${plain(activity.channel)}`;
    }

    case "CameOnline": {
      return `--> ${plain(activity.nick)} is online`;
    }

    case "Parted": {
      return `<-- ${plain(activity.nick)} left ${plain(activity.channel)}${because(activity.reason)}`;
    }

    case "Quit": {
      return `<-- ${plain(activity.nick)} quit${because(activity.reason)}`;
    }

    case "Kicked": {
      return `<-- ${plain(activity.by)} kicked ${plain(activity.nick)} from ${plain(activity.channel)}${because(activity.reason)}`;
    }

    case "WentOffline": {
      return `<-- ${plain(activity.nick)} went offline`;
    }

    default: {
      return activity satisfies never;
    }
  }
};

type CtcpActivity = Extract<
  Activity,
  { readonly _tag: "CtcpRequest" | "CtcpReply" | "CtcpSent" | "CtcpUnsent" }
>;

const isCtcp = (activity: Activity): activity is CtcpActivity =>
  activity._tag === "CtcpRequest" ||
  activity._tag === "CtcpReply" ||
  activity._tag === "CtcpSent" ||
  activity._tag === "CtcpUnsent";

/**
 * A CTCP request or reply, marked `--`.
 * @param activity - The Activity.
 * @returns Its marker and words.
 */
const ctcpText = (activity: CtcpActivity): string => {
  switch (activity._tag) {
    case "CtcpRequest": {
      const { answer } = activity;

      const answered =
        answer._tag === "Answered"
          ? `, answered ${plain(answer.text)}`
          : `, not answered: ${unanswered[answer.reason]}`;

      return `-- ${plain(activity.nick)} asked for ${ctcp(activity.command, activity.args, " ")}${answered}`;
    }

    case "CtcpReply": {
      return activity.roundTrip === null
        ? `-- ${plain(activity.nick)} replied to ${ctcp(activity.command, activity.args, ": ")}`
        : `-- ${plain(activity.nick)} replied to ${plain(activity.command)} in ${(activity.roundTrip / 1000).toFixed(3)} s`;
    }

    case "CtcpSent": {
      return `-- You asked ${plain(activity.nick)} for ${ctcp(activity.command, activity.args, " ")}`;
    }

    case "CtcpUnsent": {
      return `-- ${plain(activity.nick)} asked for ${plain(activity.command)}, the answer never left`;
    }

    default: {
      return activity satisfies never;
    }
  }
};

type FromIrcd = Extract<
  Activity,
  {
    readonly _tag: "Invited" | "OperGranted" | "OperRefused" | "StandardReply" | "Numeric" | "Motd";
  }
>;

const isFromIrcd = (activity: Activity): activity is FromIrcd =>
  activity._tag === "Invited" ||
  activity._tag === "OperGranted" ||
  activity._tag === "OperRefused" ||
  activity._tag === "StandardReply" ||
  activity._tag === "Numeric" ||
  activity._tag === "Motd";

/**
 * What the Ircd told Self, marked by a numeric's number, or `--`. The message of the day is
 * one line, its lines joined by ` / `.
 * @param activity - The Activity.
 * @returns Its marker and words.
 */
const fromIrcdText = (activity: FromIrcd): string => {
  switch (activity._tag) {
    case "Invited": {
      return `-- ${plain(activity.by)} invited you to ${plain(activity.channel)}`;
    }

    case "OperGranted": {
      return `-- ${plain(activity.nick)} is now an IRC operator`;
    }

    case "OperRefused": {
      return `-- ${plain(activity.nick)} was refused as an IRC operator (${activity.reply})`;
    }

    case "StandardReply": {
      const context = activity.context.map((each) => ` ${plain(each)}`).join("");
      const description = activity.description === "" ? "" : `: ${plain(activity.description)}`;

      return `-- ${activity.kind} ${plain(activity.command)} ${plain(activity.code)}${context}${description}`;
    }

    case "Numeric": {
      return `${plain(activity.numeric)} ${plain(activity.params.join(" "))}`;
    }

    case "Motd": {
      const cut = activity.cut ? " (cut short)" : "";

      return `-- Message of the day: ${activity.lines.map(plain).join(" / ")}${cut}`;
    }

    default: {
      return activity satisfies never;
    }
  }
};

/**
 * Something about a User or a Channel that changed, marked `--`.
 * @param activity - The Activity.
 * @returns Its marker and words.
 */
const changeText = (activity: Exclude<Activity, Movement | CtcpActivity | FromIrcd>): string => {
  switch (activity._tag) {
    case "NickChanged": {
      return `-- ${plain(activity.from)} is now known as ${plain(activity.to)}`;
    }

    case "TopicChanged": {
      return activity.topic === null || activity.topic.text === ""
        ? `-- ${plain(activity.by)} cleared the topic of ${plain(activity.channel)}`
        : `-- ${plain(activity.by)} set the topic of ${plain(activity.channel)} to "${plain(activity.topic.text)}"`;
    }

    case "ModeChanged": {
      const modes = activity.changes
        .map(
          ({ mode, param, set }) =>
            `${set ? "+" : "-"}${mode}${param === undefined ? "" : ` ${param}`}`
        )
        .join(" ");

      return `-- ${plain(activity.by)} set ${plain(modes)} on ${plain(activity.target)}`;
    }

    case "AwayChanged": {
      if (activity.away === null) {
        return `-- ${plain(activity.nick)} is back`;
      }

      return activity.away.message === ""
        ? `-- ${plain(activity.nick)} is away`
        : `-- ${plain(activity.nick)} is away: ${plain(activity.away.message)}`;
    }

    case "AccountChanged": {
      return activity.account === null
        ? `-- ${plain(activity.nick)} logged out`
        : `-- ${plain(activity.nick)} logged in as ${plain(activity.account)}`;
    }

    case "HostChanged": {
      return `-- ${plain(activity.nick)} is now ${plain(activity.user)}@${plain(activity.host)}`;
    }

    case "RealnameChanged": {
      return `-- ${plain(activity.nick)} set their real name to ${plain(activity.realname)}`;
    }

    case "UserInvited": {
      return `-- ${plain(activity.by)} invited ${plain(activity.nick)} to ${plain(activity.channel)}`;
    }

    default: {
      return activity satisfies never;
    }
  }
};

/**
 * An Activity's marker and words, as the web frontend marks them.
 * @param activity - The Activity.
 * @returns Its line, without the time.
 */
const activityText = (activity: Activity): string => {
  if (isMovement(activity)) {
    return movementText(activity);
  }

  if (isCtcp(activity)) {
    return ctcpText(activity);
  }

  return isFromIrcd(activity) ? fromIrcdText(activity) : changeText(activity);
};

const attemptedText = (attempted: Attempted): string => {
  switch (attempted._tag) {
    case "Topic": {
      return `Your topic change for ${plain(attempted.channel)}`;
    }

    case "Kick": {
      return `Your kick of ${attempted.nicks.map(plain).join(", ")} from ${plain(attempted.channel)}`;
    }

    case "Part": {
      return `Your leaving of ${plain(attempted.channel)}`;
    }

    case "Mode": {
      return `Your mode change ${plain(attempted.modes)} on ${plain(attempted.target)}`;
    }

    case "Invite": {
      return `Your invite of ${plain(attempted.nick)} to ${plain(attempted.channel)}`;
    }

    case "Nick": {
      return `Your nick change to ${plain(attempted.nick)}`;
    }

    case "Away": {
      return attempted.away ? "Marking you away" : "Marking you back";
    }

    case "Setname": {
      return "Your real name change";
    }

    case "Raw": {
      return attempted.command === null ? "Your raw line" : `Your raw ${plain(attempted.command)}`;
    }

    case "Ctcp": {
      return `Your CTCP ${plain(attempted.command)} to ${plain(attempted.nick)}`;
    }

    case "Ping": {
      return `Your PING of ${plain(attempted.nick)}`;
    }

    default: {
      return attempted satisfies never;
    }
  }
};

/**
 * What an item shows, as one line of text without its time.
 * @param content - What it shows.
 * @returns The text.
 */
const contentText = (content: Content): string => {
  switch (content._tag) {
    case "Message": {
      const delivery = content.ours?.delivery;
      // The Ircd's own text for one of ours it confirmed, which may differ from what we said.
      const text = plain(delivery?._tag === "Confirmed" ? delivery.text : content.text);
      const nick = plain(content.sender);

      switch (content.kind) {
        case "Privmsg": {
          return `<${nick}> ${text}`;
        }

        case "Action": {
          return `* ${nick} ${text}`;
        }

        case "Notice": {
          return `-${nick}- ${text}`;
        }

        default: {
          return content.kind satisfies never;
        }
      }
    }

    case "Activity": {
      return activityText(content.activity);
    }

    case "SessionBegan": {
      return `-- Connected as ${plain(content.nick)}`;
    }

    case "SessionEnded": {
      return `-- Disconnected: ${endReason(content.reason)}`;
    }

    case "ConnectionFailed": {
      const { host, port, tls } = content.ircd;

      return `-- Could not connect to ${plain(host)}:${port}${tls ? " with TLS" : ""}: ${endReason(content.reason)}`;
    }

    case "ActionRefused": {
      const { reason } = content;

      return `-- ${attemptedText(content.attempted)}${
        reason._tag === "Rejected"
          ? ` was refused (${plain(reason.reply)})`
          : " was not sent: its connection ended first"
      }`;
    }

    default: {
      return content satisfies never;
    }
  }
};

/**
 * An item as a line of an export: its time, in UTC as `toISOString` writes it, and what it
 * shows, ended by a line feed.
 * @param item - The item.
 * @returns The line.
 */
export const exportLine = (item: Pick<Item, "position" | "content">): string =>
  `${timeOf(item.position.at)} ${contentText(item.content)}\n`;

// What a file's name may not hold on any common system, besides controls and whitespace.
const pathHostile = /[/\\:*?"<>|\p{Cc}\p{Bidi_Control}\p{White_Space}\p{Cs}]/gu;

// What is not printable ASCII.
const beyondAscii = /[^\u0020-\u007E]/gu;

// What `encodeURIComponent` leaves that RFC 8187 does not allow as a `filename*` character.
const notAttrChar = /['()*]/gu;

/**
 * The `Content-Disposition` an export is given as, named for its Network and Timeline:
 * `<network>-<name>.txt`, or `<network>.txt` for the Network's own Timeline. Both names
 * came from a Network, so `filename` holds printable ASCII alone, and `filename*` the name
 * in UTF-8, each with whatever a file's name may not hold replaced by `_`.
 * @param timeline - The Timeline: its Network, kind, and name.
 * @returns The header's value.
 */
export const exportDisposition = (timeline: Pick<Summary, "network" | "kind" | "name">): string => {
  const named =
    timeline.kind === "Network"
      ? `${timeline.network}.txt`
      : `${timeline.network}-${timeline.name}.txt`;

  const safe = named.replaceAll(pathHostile, "_");
  const ascii = safe.replaceAll(beyondAscii, "_");

  const encoded = encodeURIComponent(safe).replaceAll(
    notAttrChar,
    (char) => `%${char.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`
  );

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};
