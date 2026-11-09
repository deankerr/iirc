/**
 * What a Line means, in the core's vocabulary, before Features refine it: Messages,
 * Activity, and `NAMES` listings. Each reader decides from the command and the
 * parameters' positions, never from an Ircd's text.
 *
 * @packageDocumentation
 */
import { parseCtcp } from "@iirc/protocol/ctcp";
import { chantypesOf } from "@iirc/protocol/isupport";
import { parseSource } from "@iirc/protocol/line";
import type { Line, Source } from "@iirc/protocol/line";

import type { Arrival, Meant } from "./feature.ts";
import type { Instant } from "./ids.ts";
import type { ModeRules } from "./modes.ts";
import { readListed, readModes, rulesOf } from "./modes.ts";
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
 * Whether a name is a Channel's, by `CHANTYPES`.
 * @param run - The step.
 * @returns The test.
 */
export const channelTest =
  (run: Run) =>
  (name: string): boolean => {
    const first = name.codePointAt(0);

    return (
      first !== undefined &&
      chantypesOf(openOf(run.state)?.isupport.get("CHANTYPES")).includes(
        String.fromCodePoint(first)
      )
    );
  };

/**
 * When a Line was said: from the Ircd where a Feature knows it, else when it arrived.
 * @param run - The step.
 * @param arrival - The Line.
 * @returns The instant.
 */
export const timeOf = (run: Run, arrival: Arrival): Instant =>
  arrival.time._tag === "Known" ? arrival.time.value : run.at;

const clientTags = (line: Line): ReadonlyMap<string, string> =>
  new Map([...line.tags].filter(([key]) => key.startsWith("+")));

const listOf = (names: string): readonly string[] => names.split(",").filter((name) => name !== "");

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

  // CTCP other than `ACTION` is a request or a reply between IRC clients, not something said.
  if (ctcp._tag === "Dcc" || ctcp._tag === "Other") {
    return [];
  }

  if (arrival.answers !== undefined && isSelf(run, by)) {
    return [{ _tag: "Confirmed", at: arrival.time, id: arrival.id, intent: arrival.answers, text }];
  }

  return [
    {
      _tag: "Message",
      at: arrival.time,
      id: arrival.id,
      kind: kindOf(arrival.line.command, ctcp._tag === "Action"),
      live: arrival.live,
      ours: undefined,
      sender: by,
      tags: clientTags(arrival.line),
      target,
      text: ctcp._tag === "Action" ? ctcp.text : text,
    },
  ];
};

const readers: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  ["PRIVMSG", message],
  ["NOTICE", message],
  [
    "JOIN",
    ({ params: [channels], source, activity }) =>
      channels === undefined || source === undefined
        ? unfit
        : listOf(channels).map((channel) =>
            activity({ _tag: "Joined", channel, nick: source.nick })
          ),
  ],
  [
    "PART",
    ({ params: [channels, reason], source, activity }) =>
      channels === undefined || source === undefined
        ? unfit
        : listOf(channels).map((channel) =>
            activity({ _tag: "Parted", channel, nick: source.nick, reason })
          ),
  ],
  [
    "KICK",
    ({ params: [channel, nicks, reason], by, activity }) =>
      channel === undefined || nicks === undefined
        ? unfit
        : listOf(nicks).map((nick) => activity({ _tag: "Kicked", by, channel, nick, reason })),
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
    ({ run, arrival, params: [channel, text], by, activity }) =>
      channel === undefined || text === undefined
        ? unfit
        : [
            activity({
              _tag: "TopicChanged",
              by,
              channel,
              topic: text === "" ? null : { setAt: timeOf(run, arrival), setBy: by, text },
            }),
          ],
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
