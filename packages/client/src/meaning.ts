/**
 * What a Line means, in the core's vocabulary, before Features refine it: Messages,
 * Activity, and `NAMES` listings. Each reader decides from the command and the
 * parameters' positions, never from an Ircd's text.
 *
 * @packageDocumentation
 */
import { parseCtcp } from "@iirc/protocol/ctcp";
import { parseSource } from "@iirc/protocol/line";
import type { Line, Source } from "@iirc/protocol/line";

import type { Arrival, Meant } from "./feature.ts";
import type { Instant } from "./ids.ts";
import { MessageId } from "./ids.ts";
import type { ModeRules } from "./modes.ts";
import { readListed, readModes, rulesOf } from "./modes.ts";
import type { Naming } from "./names.ts";
import { namingOf, parseChannel, parseNick } from "./names.ts";
import type { Activity } from "./news.ts";
import type { Run } from "./run.ts";
import { folder, linkOf } from "./run.ts";
import { openOf, sessionOf } from "./views.ts";

/**
 * The Ircd's name: from `001`'s source once in a Session, else the host dialled.
 * @param run - The step.
 * @returns The name.
 */
export const serverName = (run: Run): string =>
  sessionOf(run.state)?.server ?? linkOf(run)?.ircd.host ?? "";

/**
 * Whether a nick is Self's.
 * @param run - The step.
 * @param nick - The nick.
 * @returns Whether it is.
 */
export const isSelf = (run: Run, nick: string): boolean => {
  const session = sessionOf(run.state);
  const fold = folder(run.state);

  return session !== undefined && fold(session.nick) === fold(nick);
};

/**
 * The Network's mode rules now.
 * @param run - The step.
 * @returns The rules.
 */
export const rulesNow = (run: Run): ModeRules => rulesOf(openOf(run.state)?.isupport ?? new Map());

/**
 * The Network's naming rules now.
 * @param run - The step.
 * @returns The rules.
 */
export const namingNow = (run: Run): Naming => namingOf(openOf(run.state)?.isupport ?? new Map());

/**
 * Whether a name is a Channel's, as {@link parseChannel} reads it.
 * @param run - The step.
 * @returns The test.
 */
export const channelTest = (run: Run): ((name: string) => boolean) => {
  const naming = namingNow(run);

  return (name) => parseChannel(naming, name) !== undefined;
};

/**
 * When a Line was said: from the Ircd where a Feature knows it, else when it arrived.
 * @param run - The step.
 * @param arrival - The Line.
 * @returns The instant.
 */
const timeOf = (run: Run, arrival: Arrival): Instant =>
  arrival.time._tag === "Known" ? arrival.time.value : run.at;

const clientTags = (line: Line): ReadonlyMap<string, string> =>
  new Map([...line.tags].filter(([key]) => key.startsWith("+")));

// `+reply` and `+channel-context`: what a Message answers, and the Channel a Direct
// Message belongs with. Each spec says what to ignore, and an ignored tag reads as unset.

/**
 * The Message a Line answers, from its `+reply` tag.
 * @param line - The Line.
 * @returns The id it names, or `undefined` when the tag is missing or empty.
 */
const answersOf = (line: Line): MessageId | undefined => {
  const value = line.tags.get("+reply");

  return value === undefined || value === "" ? undefined : MessageId.make(value);
};

/**
 * The Channel a Direct Message was said in the context of, from its `+channel-context`
 * tag, which counts only on a Message to a User and only when it names a Channel.
 * @param run - The step.
 * @param line - The Line.
 * @param target - The Message's Target, as said.
 * @returns The Channel, or `undefined` when the tag is missing or does not count.
 */
const contextOf = (run: Run, line: Line, target: string): string | undefined => {
  const value = line.tags.get("+channel-context");

  if (value === undefined) {
    return undefined;
  }

  const naming = namingNow(run);

  return parseNick(naming, target) === undefined ? undefined : parseChannel(naming, value);
};

const listOf = (names: string): readonly string[] => names.split(",").filter((name) => name !== "");

/**
 * Reads a list of Channels' names, as `JOIN` and `PART` carry it.
 * @param run - The step.
 * @param names - The parameter.
 * @returns Each name, or `undefined` when any item cannot be a Channel's, or none is given.
 */
const channelsOf = (run: Run, names: string): readonly string[] | undefined => {
  const naming = namingNow(run);
  const read = listOf(names).map((name) => parseChannel(naming, name));

  return read.length === 0 || read.includes(undefined)
    ? undefined
    : read.filter((name) => name !== undefined);
};

/**
 * Reads one Channel's name, as `KICK` and `TOPIC` carry it.
 * @param run - The step.
 * @param name - The parameter, or `undefined` when it is missing.
 * @returns The name, or `undefined` when it is missing or cannot be a Channel's.
 */
const channelOf = (run: Run, name: string | undefined): string | undefined =>
  name === undefined ? undefined : parseChannel(namingNow(run), name);

/** What a reader is given. */
interface Said {
  readonly run: Run;
  readonly arrival: Arrival;
  readonly params: readonly string[];
  readonly source: Source | undefined;
  /** Who said it: the source's nick, or the Ircd. */
  readonly by: string;
  readonly activity: (said: Activity) => Meant;
}

/** A Line whose parameters do not fit its command. */
export const unfit = "Unfit";

/** Reads one command, or gives {@link unfit} when its parameters do not fit it. */
type Reader = (said: Said) => readonly Meant[] | typeof unfit;

const kindOf = (command: string, action: boolean) => {
  if (action) {
    return "Action";
  }

  return command === "NOTICE" ? "Notice" : "Privmsg";
};

const message: Reader = ({ run, arrival, params: [target, text], by }) => {
  if (target === undefined || text === undefined) {
    return unfit;
  }

  const ctcp = parseCtcp(text);

  // CTCP other than `ACTION` is a request or a reply between IRC clients, not something
  // said: `heardCtcp` reports it and answers it, and drops a `DCC`.
  if (ctcp._tag === "Dcc" || ctcp._tag === "Other") {
    return [];
  }

  const said = ctcp._tag === "Action" ? ctcp.text : text;

  if (arrival.answers !== undefined && isSelf(run, by)) {
    return [
      { _tag: "Confirmed", at: arrival.time, id: arrival.id, intent: arrival.answers, text: said },
    ];
  }

  return [
    {
      _tag: "Message",
      answers: answersOf(arrival.line),
      at: arrival.time,
      context: contextOf(run, arrival.line, target),
      id: arrival.id,
      kind: kindOf(arrival.line.command, ctcp._tag === "Action"),
      live: arrival.live,
      ours: undefined,
      sender: by,
      tags: clientTags(arrival.line),
      target,
      text: said,
    },
  ];
};

const readers: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  ["PRIVMSG", message],
  ["NOTICE", message],
  [
    "JOIN",
    ({ run, params: [names], source, activity }) => {
      const channels = names === undefined ? undefined : channelsOf(run, names);

      return channels === undefined || source === undefined
        ? unfit
        : channels.map((channel) => activity({ _tag: "Joined", channel, nick: source.nick }));
    },
  ],
  [
    "PART",
    ({ run, params: [names, reason], source, activity }) => {
      const channels = names === undefined ? undefined : channelsOf(run, names);

      return channels === undefined || source === undefined
        ? unfit
        : channels.map((channel) =>
            activity({ _tag: "Parted", channel, nick: source.nick, reason })
          );
    },
  ],
  [
    "KICK",
    ({ run, params: [name, nicks, reason], by, activity }) => {
      const channel = channelOf(run, name);

      return channel === undefined || nicks === undefined
        ? unfit
        : listOf(nicks).map((nick) => activity({ _tag: "Kicked", by, channel, nick, reason }));
    },
  ],
  [
    // `INVITE <nick> <channel>`. One naming another User is for `invite-notify`, and not Self's
    // to report.
    "INVITE",
    ({ run, params: [nick, name], source, activity }) => {
      if (nick === undefined || name === undefined || source === undefined) {
        return unfit;
      }

      if (!isSelf(run, nick)) {
        return [];
      }

      const channel = channelOf(run, name);

      return channel === undefined
        ? unfit
        : [activity({ _tag: "Invited", by: source.nick, channel })];
    },
  ],
  [
    "QUIT",
    ({ params: [reason], source, activity }) =>
      source === undefined ? unfit : [activity({ _tag: "Quit", nick: source.nick, reason })],
  ],
  [
    "NICK",
    ({ params: [to], source, activity }) =>
      to === undefined || source === undefined
        ? unfit
        : [activity({ _tag: "NickChanged", from: source.nick, to })],
  ],
  [
    "MODE",
    ({ run, params: [target, modes, ...args], by, activity }) => {
      if (target === undefined || modes === undefined) {
        return unfit;
      }

      const rules = channelTest(run)(target) ? rulesNow(run) : undefined;

      return [
        activity({ _tag: "ModeChanged", by, changes: readModes(modes, args, rules), target }),
      ];
    },
  ],
  [
    "TOPIC",
    ({ run, arrival, params: [name, text], by, activity }) => {
      const channel = channelOf(run, name);

      return channel === undefined || text === undefined
        ? unfit
        : [
            activity({
              _tag: "TopicChanged",
              by,
              channel,
              topic: text === "" ? null : { setAt: timeOf(run, arrival), setBy: by, text },
            }),
          ];
    },
  ],
  [
    "AWAY",
    ({ params: [text], source, activity }) =>
      source === undefined
        ? unfit
        : [
            activity({
              _tag: "AwayChanged",
              away: text === undefined || text === "" ? null : { message: text },
              nick: source.nick,
            }),
          ],
  ],
  [
    // `353 <client> <symbol> <channel> :<names>`, where an old Ircd may leave out the symbol.
    "353",
    ({ run, arrival, params }) => {
      const [channel, names] = params.slice(-2);

      if (params.length < 3 || channel === undefined || names === undefined) {
        return unfit;
      }

      const rules = rulesNow(run);
      const at = timeOf(run, arrival);

      return [
        {
          _tag: "Listed",
          channel,
          members: names.split(" ").flatMap((name) => {
            const member = name === "" ? undefined : readListed(name, rules, at);

            return member === undefined ? [] : [member];
          }),
        },
      ];
    },
  ],
]);

/**
 * Whether the core reads meaning from a command, through the `meaning` stage.
 * @param command - The command.
 * @returns Whether it does.
 */
export const hasMeaning = (command: string): boolean => readers.has(command);

/**
 * What a Line means.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @returns What it means, or {@link unfit} when its parameters do not fit its command.
 */
export const derive = (run: Run, arrival: Arrival): readonly Meant[] | typeof unfit => {
  const { line } = arrival;
  const reader = readers.get(line.command);
  const source = line.source === undefined ? undefined : parseSource(line.source);

  if (reader === undefined) {
    return [];
  }

  return reader({
    activity: (said) => ({
      _tag: "Activity",
      activity: said,
      at: arrival.time,
      id: arrival.id,
      live: arrival.live,
    }),
    arrival,
    by: source?.nick ?? serverName(run),
    params: line.params,
    run,
    source,
  });
};
