/**
 * What each received Line does, once ingress has refined it: protocol Lines move the
 * machines on, and Lines with meaning go through the `meaning` stage and are folded into
 * the model and reported.
 *
 * @packageDocumentation
 */
import { casemappingOf, defaultCasemapping } from "@iirc/protocol/casemapping";
import { isupportTokens } from "@iirc/protocol/isupport";
import { parseSource, pong, upperCaseAscii } from "@iirc/protocol/line";
import type { Line, RawParam } from "@iirc/protocol/line";

import {
  actionByCommand,
  answered,
  modeAnswer,
  nickAnswer,
  resendAway,
  sendOwnStart,
  tiedAction,
  tieRejection,
} from "./acts.ts";
import {
  changeJoined,
  channelsSharedWith,
  endOfNames,
  foldActivity,
  foldListed,
  joinWanted,
  listedPart,
  remap,
  refused,
  see,
} from "./channels.ts";
import { forgetPings, heardCtcp } from "./ctcp.ts";
import type { Arrival, Meant } from "./feature.ts";
import { identified, identify } from "./identify.ts";
import { Instant } from "./ids.ts";
import type { IntentId } from "./ids.ts";
import {
  collectFloor,
  collectLabelled,
  collectListed,
  endLone,
  endsApart,
  floorLookup,
  isNumeric,
  lookupByCommand,
} from "./lookups.ts";
import { followRenames, refoldMarkers } from "./markers.ts";
import { channelTest, derive, hasMeaning, isSelf, rulesNow, unfit } from "./meaning.ts";
import { askModes, modesQueryOver, queryAnswered, queryByCommand } from "./modes-query.ts";
import { applyModes, readModes } from "./modes.ts";
import { isMonitorReply, left, monitorRefused, monitorReply } from "./monitor.ts";
import { collectMotd } from "./motd.ts";
import { changesNothingHere } from "./news.ts";
import type { Activity, ModeChange, StandardReply, Where } from "./news.ts";
import { answersOper, oper, operAnswered } from "./oper.ts";
import {
  reclaim,
  reclaimAsked,
  reclaimOver,
  reclaimRefused,
  reclaimTaken,
  yieldedBy,
} from "./reclaim.ts";
import {
  abandon,
  capLine,
  loginOwed,
  carryOutRefined,
  nickRefused,
  offered,
  refusesCap,
  unknownCommand,
  welcomed,
} from "./registration.ts";
import { isStandardReply, readReply } from "./replies.ts";
import type { Run } from "./run.ts";
import {
  folder,
  ignore,
  linkOf,
  readingOf,
  refuseIntent,
  rememberedAction,
  send,
  updateOpen,
} from "./run.ts";
import { runStage } from "./seam.ts";
import { maxConfirmed } from "./state.ts";
import { lagAfter } from "./timers.ts";
import { noUsers, userIn } from "./users.ts";
import { onNow, openOf, sessionOf } from "./views.ts";
import { followSays, named, routeActivity, routeMessage, saidWhere } from "./where.ts";
import {
  askWho,
  whoEnded,
  whoNamed,
  whoQueryOver,
  whoRefused,
  whoReply,
  whoxReply,
} from "./who-query.ts";

/** The numerics that refuse a `JOIN`, naming the Channel in their second parameter. */
const refusals: ReadonlySet<string> = new Set([
  "403",
  "405",
  "471",
  "473",
  "474",
  "475",
  "476",
  "477",
  "489",
]);

/** The numerics that refuse a nick before `001`. */
const nickRefusals: ReadonlySet<string> = new Set(["432", "433", "436"]);

/** The most ISUPPORT tokens kept, so a hostile Ircd cannot grow the State without bound. */
const maxTokens = 256;

const isRegistering = (run: Run): boolean => openOf(run.state)?.presence._tag === "Registering";

// Our own mask, as a Line from Self shows it.
const ownMask = (run: Run, user: string, host: string): void => {
  updateOpen(run, (open) =>
    open.presence._tag === "Session"
      ? {
          ...open,
          presence: {
            ...open.presence,
            mask: { _tag: "Known", at: run.at, from: "ircd", value: { host, user } },
          },
        }
      : open
  );
};

// Whether Self is a bot, as Self's own Lines and modes say it.
const ownBot = (run: Run, bot: boolean): void => {
  updateOpen(run, (open) =>
    open.presence._tag === "Session"
      ? {
          ...open,
          presence: {
            ...open.presence,
            bot: { _tag: "Known", at: run.at, from: "ircd", value: bot },
          },
        }
      : open
  );
};

// Self's away status, as the Ircd says it.
const selfAway = (run: Run, away: { readonly message: string } | null): void => {
  updateOpen(run, (open) =>
    open.presence._tag === "Session"
      ? {
          ...open,
          presence: {
            ...open.presence,
            away: { _tag: "Known", at: run.at, from: "ircd", value: away },
          },
        }
      : open
  );
};

/**
 * The Ircd confirmed Self away or back, with `306` or `305`, which says no source: it is
 * known, and reported as Self's `AwayChanged`, which belongs to the Network's own
 * Timeline, so a Frontend learns of it from the projection.
 * @param run - The step.
 * @param away - Away with the message last sent, or `null` for back.
 */
const confirmedAway = (run: Run, away: { readonly message: string } | null): void => {
  const nick = sessionOf(run.state)?.nick;

  if (nick === undefined) {
    return;
  }

  run.news.push(
    routeActivity(
      run,
      {
        _tag: "Activity",
        activity: { _tag: "AwayChanged", away, nick },
        at: { _tag: "Known", at: run.at, from: "receipt", value: run.at },
        id: { _tag: "Unknown" },
        live: true,
      },
      undefined
    )
  );
  selfAway(run, away);
};

// A `MODE` from Self answers each change it made, by its sign and letter, and a
// Channel's membership mode by its nick too.
const modesAnswered = (run: Run, target: string, changes: readonly ModeChange[]): void => {
  const { prefix } = rulesNow(run);
  const onChannel = channelTest(run)(target);

  for (const change of changes) {
    const membership = onChannel && prefix.some(({ mode }) => mode === change.mode);

    answered(run, "MODE", [target], modeAnswer(change, membership));
  }
};

// Self's own topic change, kick, or part answers the Line of an action on its Channel.
const channelSettled = (
  run: Run,
  activity: Activity & { readonly _tag: "TopicChanged" | "Kicked" | "Parted" }
): void => {
  switch (activity._tag) {
    case "TopicChanged": {
      if (isSelf(run, activity.by)) {
        answered(run, "TOPIC", [activity.channel]);
      }

      break;
    }

    case "Kicked": {
      if (isSelf(run, activity.by)) {
        answered(run, "KICK", [activity.channel], nickAnswer(activity.nick));
      }

      break;
    }

    case "Parted": {
      if (isSelf(run, activity.nick)) {
        answered(run, "PART", [activity.channel]);
      }

      break;
    }

    default: {
      activity satisfies never;
    }
  }
};

// Whether two nicks are one, folded by the Connection's casemapping.
const isSameNick = (run: Run, first: string, second: string): boolean => {
  const fold = folder(run.state);

  return fold(first) === fold(second);
};

// A nick changed, live: Self's answers the Line that asked for it, and another User's may
// free a nick Self wants back.
const nickSettled = (run: Run, from: string, to: string): void => {
  if (isSelf(run, from)) {
    yieldedBy(run, from, to);

    // The Client's own ask answers a change to its nick when it was sent first.
    if (!reclaimTaken(run, to)) {
      answered(run, "NICK", [to]);
    }
  } else if (!isSameNick(run, from, to) && left(run, from)) {
    // A case-only change keeps the nick, so it leaves nothing to take, and a leave
    // `MONITOR` already told of is not asked for twice.
    reclaim(run, from);
  }
};

// Self's own `AWAY` says whether Self is away, a User's `QUIT` forgets the `PING`s sent to
// them, and a User seen leaving a nick, by `QUIT` or `NICK`, may free the nick Self wants
// back.
const userSettled = (
  run: Run,
  activity: Activity & { readonly _tag: "NickChanged" | "AwayChanged" | "Quit" }
): void => {
  switch (activity._tag) {
    case "NickChanged": {
      nickSettled(run, activity.from, activity.to);

      break;
    }

    case "AwayChanged": {
      if (isSelf(run, activity.nick)) {
        selfAway(run, activity.away);
      }

      break;
    }

    case "Quit": {
      forgetPings(run, activity.nick);

      if (left(run, activity.nick)) {
        reclaim(run, activity.nick);
      }

      break;
    }

    default: {
      activity satisfies never;
    }
  }
};

// What Self did, live, answers the Line of an action that asked for it, and what a User
// did is settled by {@link userSettled}.
const settled = (run: Run, activity: Activity): void => {
  if (changesNothingHere(activity)) {
    return;
  }

  switch (activity._tag) {
    case "TopicChanged":
    case "Kicked":
    case "Parted": {
      channelSettled(run, activity);

      break;
    }

    case "ModeChanged": {
      if (isSelf(run, activity.by)) {
        modesAnswered(run, activity.target, activity.changes);
      }

      break;
    }

    case "NickChanged":
    case "AwayChanged":
    case "Quit": {
      userSettled(run, activity);

      break;
    }

    // Self's own new realname answers the oldest `SETNAME` still awaiting one.
    case "RealnameChanged": {
      if (isSelf(run, activity.nick)) {
        answered(run, "SETNAME", []);
      }

      break;
    }

    case "Joined":
    case "AccountChanged":
    case "HostChanged":
    case "StandardReply":
    case "CtcpRequest":
    case "CtcpReply":
    case "CtcpSent":
    case "CtcpUnsent": {
      break;
    }

    default: {
      activity satisfies never;
    }
  }
};

const none: ReadonlySet<string> = new Set();

// A member's nick as `userhost-in-names` leaves it, bare, whether the core read it with
// the mask or not, so the core's reading and a Feature's refining name the same member.
const memberKey = (channel: string, nick: string): string =>
  `${channel} ${nick.split("!", 1)[0] ?? nick}`;

// The members of a listing whose prefixes the core knew only in part, and a Feature made
// known in full.
const listedWith = (meant: readonly Meant[], tag: "Partial" | "Known"): readonly string[] =>
  meant.flatMap((each) =>
    each._tag === "Listed"
      ? each.members
          .filter((member) => member.prefixes._tag === tag)
          .map((member) => memberKey(each.channel, member.nick))
      : []
  );

const completedBy = (derived: readonly Meant[], refined: readonly Meant[]): ReadonlySet<string> => {
  const partial = new Set(listedWith(derived, "Partial"));

  return new Set(listedWith(refined, "Known").filter((key) => partial.has(key)));
};

// What a live Line said of a User who shares a Channel with Self: each fact it gave.
const describing = (run: Run, meant: Extract<Meant, { readonly _tag: "Described" }>): void => {
  const { account, bot, mask, realname } = meant;

  // Self's own mask and bot mark are known as a Line from Self shows them, and `see` is for
  // other Users.
  if (isSelf(run, meant.nick)) {
    if (mask !== undefined) {
      ownMask(run, mask.user, mask.host);
    }

    if (bot !== undefined) {
      ownBot(run, bot);
    }

    return;
  }

  see(run, meant.nick, (seen) => ({
    ...seen,
    account:
      account === undefined
        ? seen.account
        : { _tag: "Known", at: run.at, from: "ircd", value: account },
    bot: bot === undefined ? seen.bot : { _tag: "Known", at: run.at, from: "ircd", value: bot },
    mask: mask === undefined ? seen.mask : { _tag: "Known", at: run.at, from: "ircd", value: mask },
    realname:
      realname === undefined
        ? seen.realname
        : { _tag: "Known", at: run.at, from: "ircd", value: realname },
  }));
};

// Whether a User is shown as a bot: their mark, while it is known now, which a Frontend's
// list of members reads, and nothing when it is stale or not known.
const shownBot = (run: Run, nick: string): boolean | undefined => {
  const fact = isSelf(run, nick)
    ? sessionOf(run.state)?.bot
    : userIn(openOf(run.state)?.users ?? noUsers, folder(run.state)(nick))?.bot;

  return fact?._tag === "Known" ? fact.value : undefined;
};

// A bot mark a Line first gave, or changed, is no Activity, so each Channel the User is in is
// reported learned, for a Frontend to read its members again.
const described = (run: Run, meant: Extract<Meant, { readonly _tag: "Described" }>): void => {
  const before = shownBot(run, meant.nick);

  describing(run, meant);

  if (meant.bot !== undefined && shownBot(run, meant.nick) !== before) {
    for (const channel of channelsSharedWith(run, meant.nick)) {
      run.news.push({ _tag: "ChannelLearned", channel: named(run, channel) });
    }
  }
};

type ModelOnly = Extract<Meant, { readonly _tag: "Listed" | "Described" }>;

const isModelOnly = (meant: Meant): meant is ModelOnly =>
  meant._tag === "Listed" || meant._tag === "Described";

// Folds what only the model sees: a `NAMES` listing, and what a Line said of a User. Neither
// is News, and history changes nothing.
const foldModelOnly = (
  run: Run,
  meant: ModelOnly,
  arrival: Arrival,
  completed: ReadonlySet<string>
): void => {
  if (!arrival.live) {
    return;
  }

  if (meant._tag === "Listed") {
    const part = listedPart(run, meant.members, (nick) =>
      completed.has(memberKey(meant.channel, nick))
    );

    // A `NAMES` Lookup's answer is its own listing, which never reaches the Channel's.
    if (!collectListed(run, arrival, meant, part)) {
      foldListed(run, meant.channel, part);
    }
  } else {
    described(run, meant);
  }
};

// Folds live Activity into the Channels, and asks the modes of one Self joined.
const foldLive = (run: Run, activity: Activity): void => {
  foldActivity(run, activity, rulesNow(run), channelTest(run));

  if (activity._tag === "Joined" && isSelf(run, activity.nick)) {
    askModes(run);
  }
};

// Folds what a Line meant into the model, and reports it. History is reported, and
// never changes what is known now.
const fold = (
  run: Run,
  meant: Meant,
  arrival: Arrival,
  completed: ReadonlySet<string> = none
): void => {
  const { line, live } = arrival;

  if (isModelOnly(meant)) {
    foldModelOnly(run, meant, arrival, completed);

    return;
  }

  const source = line.source === undefined ? undefined : parseSource(line.source);

  // Where it belongs is worked out before it changes what is known, so a Quit lists the
  // Channels the User was in.
  if (meant._tag === "Message") {
    run.news.push(routeMessage(run, meant, source));
  } else if (meant._tag === "Activity") {
    const routed = routeActivity(run, meant, source);

    run.news.push(routed);
    followRenames(run, routed.where);
    followSays(run, routed.where);
  } else {
    run.news.push(meant);
  }

  if (meant._tag === "Confirmed") {
    const { intent } = meant;

    updateOpen(run, (open) => ({
      ...open,
      confirmed: [...open.confirmed, intent].slice(-maxConfirmed),
    }));
  }

  if (meant._tag !== "Activity" || !live) {
    return;
  }

  const { activity } = meant;
  const selfRenamed = activity._tag === "NickChanged" && isSelf(run, activity.from);

  settled(run, activity);
  foldLive(run, activity);

  if (selfRenamed) {
    updateOpen(run, (open) =>
      open.presence._tag === "Session"
        ? { ...open, presence: { ...open.presence, nick: activity.to } }
        : open
    );
  }

  const { user, host } = source ?? {};

  // A `CHGHOST`'s source is the mask the User had, which it has just replaced.
  if (
    source === undefined ||
    user === undefined ||
    host === undefined ||
    activity._tag === "HostChanged"
  ) {
    return;
  }

  if (isSelf(run, source.nick)) {
    ownMask(run, user, host);
  } else if (activity._tag === "Joined" || activity._tag === "NickChanged") {
    see(run, activity._tag === "Joined" ? source.nick : activity.to, (seen) => ({
      ...seen,
      mask: { _tag: "Known", at: run.at, from: "ircd", value: { host, user } },
    }));
  }
};

const means = (run: Run, arrival: Arrival): void => {
  const derived = derive(run, arrival);

  if (derived === unfit) {
    ignore(run, { _tag: "Malformed", command: arrival.line.command });

    return;
  }

  const features = onNow(run.registry, run.state).filter(
    (feature) => feature.meaning !== undefined
  );

  const reading = features.length === 0 ? undefined : readingOf(run);
  const seam = openOf(run.state)?.seam;

  if (reading !== undefined && seam !== undefined) {
    const ran = runStage(features, seam, reading, derived, (feature, value, context) =>
      feature.meaning?.(value, arrival, context)
    );

    carryOutRefined(run, ran);

    const completed = completedBy(derived, ran.value);

    for (const each of ran.value) {
      fold(run, each, arrival, completed);
    }

    return;
  }

  for (const each of derived) {
    fold(run, each, arrival);
  }
};

const welcome = (run: Run, line: Line): void => {
  const open = openOf(run.state);
  const link = linkOf(run);

  if (open === undefined || link === undefined || open.presence._tag !== "Registering") {
    ignore(run, { _tag: "NotNow", input: "Received" });

    return;
  }

  // What registration sent, not what the Configuration says now.
  const { account, realname } = open.presence;
  const [first] = line.params;
  const nick = first ?? offered(run) ?? "*";

  welcomed(run);

  // A login the Configuration requires never happened: give up, and take up no Session.
  if (linkOf(run)?.closing === undefined && loginOwed(run)) {
    abandon(run, { _tag: "LoginFailed" });
  }

  // A Feature, or the login rule, gave up the Connection: registration is not taken up.
  if (linkOf(run)?.closing !== undefined) {
    return;
  }

  updateOpen(run, (phase) => ({
    ...phase,
    presence: {
      _tag: "Session",
      account,
      // A User who has just registered is not away, until an `AWAY` of ours says so.
      away: { _tag: "Known", at: run.at, from: "receipt", value: null },
      began: run.at,
      // Whether Self is a bot is unknown until a Line from Self, or its own `MODE`, says.
      bot: { _tag: "Unknown" },
      chosen: false,
      identifying: undefined,
      keepalive: { check: Instant.make(run.at + lagAfter), heard: run.at, pinged: false },
      // `001`'s text is for people. Self's mask waits for a structured source, such as
      // the echo of our own `JOIN`.
      mask: { _tag: "Unknown" },
      nick,
      opering: false,
      realname: { _tag: "Known", at: phase.opened, from: "ours", value: realname },
      server: line.source ?? link.ircd.host,
      yielded: false,
    },
  }));
  run.news.push({ _tag: "SessionBegan", at: run.at, nick });
  // A service login is told before anything else, so the Channels can wait on it.
  identify(run);
  // An operator login is sent as each Session begins, and its answer awaited.
  oper(run);
  // The Owner's away outlives Sessions: each begins by saying it again.
  resendAway(run);

  // The Owner's own start to the Session waits on a service login, as the Channels do.
  if (sessionOf(run.state)?.identifying === undefined) {
    sendOwnStart(run);
  }

  joinWanted(run);
};

const isupport = (run: Run, line: Line): void => {
  const tokens = isupportTokens(line.params);

  updateOpen(run, (open) => {
    const next = new Map(open.isupport);

    for (const token of tokens) {
      if (token._tag === "Removed") {
        next.delete(token.name);
      } else if (next.has(token.name) || next.size < maxTokens) {
        next.set(token.name, token.value);
      }
    }

    return { ...open, isupport: next };
  });

  const tokensNow = openOf(run.state)?.isupport ?? new Map<string, string>();

  const mapping =
    casemappingOf(tokensNow.get("CASEMAPPING"), tokensNow.get("UTF8MAPPING")) ?? "ascii";

  // The Network declares its mapping only by a Line that names it, set or taken back, so
  // a `005` without it leaves the one the Network last declared, on any Connection.
  const declares = tokens.some(({ name }) => name === "CASEMAPPING" || name === "UTF8MAPPING");

  // Keys were folded by `rfc1459` until a mapping was declared, so declaring that one
  // changes no key and reports nothing.
  if (declares && mapping !== run.state.declared) {
    const before = run.state.declared ?? defaultCasemapping;

    run.state = { ...run.state, declared: mapping };

    if (mapping !== before) {
      run.news.push({ _tag: "Refolded", casemapping: mapping });
      refoldMarkers(run, mapping);
    }
  }

  if (mapping !== run.state.casemapping) {
    remap(run, mapping);
  }
};

const account = (run: Run, value: string | null): void => {
  const fact = { _tag: "Known", at: run.at, from: "ircd", value } as const;

  updateOpen(run, (open) => ({ ...open, presence: { ...open.presence, account: fact } }));
};

const malformed = (run: Run, line: Line): void => {
  ignore(run, { _tag: "Malformed", command: line.command });
};

/**
 * Reports that a reply changed what is known of a Channel Self is in, which no Activity
 * says, so a projection tells a Frontend to read it again.
 * @param run - The step.
 * @param channel - The Channel, as the reply names it.
 */
const learned = (run: Run, channel: string): void => {
  if (run.state.channels.get(folder(run.state)(channel))?.phase._tag === "Joined") {
    run.news.push({ _tag: "ChannelLearned", channel: named(run, channel) });
  }
};

// `332 <client> <channel> :<topic>`, `331 <client> <channel>`, and
// `333 <client> <channel> <who> <when>`. Replies to our `JOIN` are said as it happened.
const topicReply = (run: Run, line: Line): void => {
  const [, channel, third, fourth] = line.params;

  if (channel === undefined || (line.command !== "331" && third === undefined)) {
    malformed(run, line);

    return;
  }

  learned(run, channel);
  changeJoined(run, channel, (joined) => {
    const from = joined.burst ? "ircd" : "replied";

    if (line.command === "331" || (line.command === "332" && third === "")) {
      return { ...joined, topic: { _tag: "Known", at: run.at, from, value: null } };
    }

    if (line.command === "332") {
      return {
        ...joined,
        topic: {
          _tag: "Known",
          at: run.at,
          from,
          value: { setAt: undefined, setBy: undefined, text: third ?? "" },
        },
      };
    }

    const { topic } = joined;
    const seconds = /^\d{1,12}$/u.test(fourth ?? "") ? Number(fourth) : undefined;

    return topic._tag === "Known" && topic.value !== null
      ? {
          ...joined,
          topic: {
            ...topic,
            value: {
              ...topic.value,
              setAt: seconds === undefined ? undefined : Instant.make(seconds * 1000),
              setBy: parseSource(third ?? "").nick,
            },
          },
        }
      : joined;
  });
};

// `324 <client> <channel> <modes> <args>…`, every mode the Channel has.
const channelModes = (run: Run, line: Line): void => {
  const [, channel, modes, ...args] = line.params;

  if (channel === undefined || modes === undefined) {
    malformed(run, line);

    return;
  }

  const rules = rulesNow(run);
  const changes = readModes(modes, args, rules);

  learned(run, channel);
  changeJoined(run, channel, (joined) => ({
    ...joined,
    modes: {
      _tag: "Known",
      at: run.at,
      from: "replied",
      value: applyModes(new Map(), changes, rules),
    },
  }));
};

const second = (run: Run, line: Line, then: (name: string) => void): void => {
  const [, name] = line.params;

  if (name === undefined) {
    malformed(run, line);
  } else {
    then(name);
  }
};

/** What a protocol Line does: its Line, and its parameters' bytes when they are at hand. */
type Handler = (run: Run, line: Line, raw: readonly RawParam[] | undefined) => void;

const handlers: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  [
    "PING",
    (run, line, raw) => {
      const token = raw?.[0] ?? line.params[0];

      if (token === undefined) {
        malformed(run, line);
      } else {
        send(run, pong(token), "PONG");
      }
    },
  ],
  [
    "ERROR",
    (run) => {
      updateOpen(run, (open) => ({ ...open, error: true }));
    },
  ],
  ["CAP", capLine],
  ["421", unknownCommand],
  ["001", welcome],
  ["005", isupport],
  [
    "900",
    (run, line) => {
      const name = line.params.at(2);

      if (name === undefined) {
        malformed(run, line);
      } else {
        account(run, name);
        // Self is logged in, so Channels waiting on a service login need wait no longer.
        identified(run);
      }
    },
  ],
  [
    "903",
    (run) => {
      updateOpen(run, (open) => ({ ...open, loggedIn: true }));
    },
  ],
  [
    "901",
    (run) => {
      account(run, null);
    },
  ],
  // `305` and `306` answer our `AWAY`: Self is back, or away with what it last sent.
  [
    "305",
    (run) => {
      confirmedAway(run, null);
    },
  ],
  [
    "306",
    (run) => {
      confirmedAway(run, { message: openOf(run.state)?.asked ?? "" });
    },
  ],
  // `341 <client> <nick> <channel>`: an invite went out.
  [
    "341",
    (run, line) => {
      const [, nick, channel] = line.params;

      if (nick === undefined || channel === undefined) {
        malformed(run, line);
      } else {
        answered(run, "INVITE", [nick, channel]);
      }
    },
  ],
  // `381` grants the `OPER` sent as the Session began, and `464`, `491`, or `461` refuse it.
  ["381", operAnswered],
  ["461", operAnswered],
  ["464", operAnswered],
  ["491", operAnswered],
  ["331", topicReply],
  ["332", topicReply],
  ["333", topicReply],
  ["324", channelModes],
  [
    "366",
    (run, line) => {
      second(run, line, (name) => {
        learned(run, name);
        endOfNames(run, name);
        // Its members are listed now, so who they are can be asked.
        askWho(run);
      });
    },
  ],
  ["315", whoEnded],
  ["352", whoReply],
  ["354", whoxReply],
]);

// A protocol Line moves the machines on.
const protocolLine = (run: Run, line: Line, raw: readonly RawParam[] | undefined): void => {
  const { command } = line;

  if (refusals.has(command) || (command === "437" && !isRegistering(run))) {
    second(run, line, (name) => {
      refused(run, name);
    });
  } else if (nickRefusals.has(command) || command === "437") {
    if (isRegistering(run)) {
      nickRefused(run);
    }
  } else {
    handlers.get(command)?.(run, line, raw);
  }
};

/**
 * Whether a Line that answers an intent rejects it, and the reply, read by structure: an
 * error numeric is its number, a `FAIL` is its code, as standard replies give it, and an
 * `ACK` says the Ircd did nothing it would echo.
 * @param line - The Line.
 * @returns The reply, or `undefined` if it does not reject.
 */
const rejection = (line: Line): string | undefined => {
  const { command } = line;

  if (/^[45]\d\d$/u.test(command) || command === "ACK") {
    return command;
  }

  return command === "FAIL" ? (line.params[1] ?? command) : undefined;
};

/**
 * Gives a numeric tied to nothing by label to the oldest of what waits for it on the
 * floor: a Lookup whose reply it can be part of, an action's Line whose error it names,
 * the Client's own `MODE` query it answers, or the Client's own ask for a nick it refuses,
 * by the order they were sent. The ask settles no intent. A `421` or `461` naming `WHO`
 * that none of them takes refuses the Client's own `WHO` query, which waits among none.
 * @param run - The step.
 * @param line - The Line, live, outside any batch, and with no label.
 * @returns Whether anything took it.
 */
const floor = (run: Run, line: Line): boolean => {
  const looking = floorLookup(run, line);
  const tied = tiedAction(run, line);
  const query = queryAnswered(run, line);
  const asked = reclaimRefused(run, line);
  const first = Math.min(looking?.order ?? Infinity, tied?.order ?? Infinity);

  if (asked !== undefined && asked.order < Math.min(first, query?.order ?? Infinity)) {
    reclaimOver(run);
  } else if (query !== undefined && query.order < first) {
    modesQueryOver(run);
  } else if (looking !== undefined && (tied === undefined || looking.order < tied.order)) {
    collectFloor(run, looking, line);
  } else if (tied !== undefined) {
    tieRejection(run, line, tied);
  } else if (whoRefused(run, line)) {
    whoQueryOver(run);
  } else {
    return false;
  }

  return true;
};

/**
 * The numerics never shown as they came, by number alone: those the Client reads into what
 * it knows with no word to show, and those another News already reports. A numeric that answers a Lookup or an action is found by
 * what waits for it, not listed here.
 *
 * - `005`: the Ircd's ISUPPORT tokens.
 * - `305`, `306`: Self is back or away, reported as `AwayChanged`.
 * - `315`, `352`, `354`: the Client's own `WHO` of a Channel's members.
 * - `324`, `329`: a Channel's modes and when it was made, the reply to the Client's own `MODE`.
 * - `331`, `332`, `333`: a Channel's topic, read into the Channel.
 * - `341`: an invite went out, which settles the Owner's `INVITE`.
 * - `353`, `366`: a Channel's members, read into the Channel.
 *
 * What `MONITOR` tells is taken before this always, and what `WATCH` tells while the Client
 * keeps its list.
 */
const unshown: ReadonlySet<string> = new Set([
  "005",
  "305",
  "306",
  "315",
  "324",
  "329",
  "331",
  "332",
  "333",
  "341",
  "352",
  "353",
  "354",
  "366",
]);

/**
 * Shows a numeric that nothing else reports in the Network's own Timeline, as it came: its
 * number, and its parameters after the first, which names Self.
 * @param run - The step.
 * @param arrival - The numeric, live, and tied to nothing.
 */
const reportNumeric = (run: Run, arrival: Arrival): void => {
  const { command, params } = arrival.line;

  run.news.push({
    _tag: "Activity",
    activity: { _tag: "Numeric", numeric: command, params: params.slice(1) },
    at: arrival.time,
    id: arrival.id,
    live: true,
    where: [{ _tag: "Network" }],
  });
};

/**
 * Where what answers an intent belongs: where the action belongs, or where the Message of
 * a `Say` stands, and otherwise the Network's own Timeline.
 * @param run - The step.
 * @param intent - The intent.
 * @returns The Timelines.
 */
const intentWhere = (run: Run, intent: IntentId): readonly Where[] => {
  const action = rememberedAction(run, intent);
  const target = run.state.said.get(intent);

  if (action !== undefined) {
    return [action.where];
  }

  return target === undefined ? [{ _tag: "Network" }] : saidWhere(run, target);
};

const reportReply = (
  run: Run,
  arrival: Arrival,
  reply: StandardReply,
  where: readonly Where[]
): void => {
  run.news.push({
    _tag: "Activity",
    activity: { _tag: "StandardReply", ...reply },
    at: arrival.time,
    id: arrival.id,
    live: arrival.live,
    where,
  });
};

/**
 * Where the latest `Say` of a command stands, for a standard reply that names `PRIVMSG` or
 * `NOTICE`, compared without regard to ASCII case. Only a `Say` sent on this Connection
 * with no label is remembered, so a reply without one is a guess, which the Message it is
 * shown with does not claim to settle.
 * @param run - The step.
 * @param command - The command the reply names.
 * @returns The Timelines, or `undefined` for a command no `Say` sent, or none said yet.
 */
const latestSayWhere = (run: Run, command: string): readonly Where[] | undefined => {
  const verb = upperCaseAscii(command);
  const lastSaid = openOf(run.state)?.lastSaid;
  const target = verb === "PRIVMSG" || verb === "NOTICE" ? lastSaid?.[verb] : undefined;

  return target === undefined ? undefined : saidWhere(run, target);
};

/**
 * Gives a standard reply on the floor to the Client's own `MODE` query, when it names
 * `MODE` and the query was sent before any Lookup or action it could answer, or to its
 * own `WHO` query, when it names `WHO` and no Lookup or action could take it: a `FAIL`
 * ends the query, and the next Channel is asked. The query is News of nothing, so the
 * reply is shown in the Network's own Timeline.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @param reply - The standard reply.
 * @returns Whether the query took it.
 */
const toQuery = (run: Run, arrival: Arrival, reply: StandardReply): boolean => {
  const query = queryByCommand(run, reply.command);
  const looking = lookupByCommand(run, reply);
  const acting = actionByCommand(run, reply.command);
  const first = Math.min(looking?.order ?? Infinity, acting?.order ?? Infinity);
  const who = first === Infinity && whoNamed(run, reply.command);

  if (!who && (query === undefined || query.order > first)) {
    return false;
  }

  if (reply.kind === "FAIL") {
    if (who) {
      whoQueryOver(run);
    } else {
      modesQueryOver(run);
    }
  }

  reportReply(run, arrival, reply, [{ _tag: "Network" }]);

  return true;
};

/**
 * Gives a standard reply on the floor to the Client's own ask for a nick, when it names
 * `NICK` and the ask was sent before any Lookup or action it could answer: a `FAIL` ends
 * the ask, and a `WARN` or `NOTE` settles nothing. The ask is News of nothing, so the reply
 * is shown in the Network's own Timeline.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @param reply - The standard reply.
 * @returns Whether the ask took it.
 */
const toReclaim = (run: Run, arrival: Arrival, reply: StandardReply): boolean => {
  const asked = reclaimAsked(run);
  const looking = lookupByCommand(run, reply);
  const acting = actionByCommand(run, reply.command);
  const first = Math.min(looking?.order ?? Infinity, acting?.order ?? Infinity);

  if (asked === undefined || upperCaseAscii(reply.command) !== "NICK" || asked.order > first) {
    return false;
  }

  if (reply.kind === "FAIL") {
    reclaimOver(run);
  }

  reportReply(run, arrival, reply, [{ _tag: "Network" }]);

  return true;
};

/**
 * A standard reply that refused no intent, shown with what it answers. A labelled one is
 * shown where its intent belongs, as `labeled-response` marked it. One live outside any
 * batch or label is tied by the command it names to the oldest of what awaits an answer
 * with that command: a Lookup collects it, a `FAIL` refuses an action as `421` does, by its
 * code, and a `WARN` or a `NOTE` is shown where the action belongs and settles nothing.
 * One that names `PRIVMSG` or `NOTICE` is shown where the latest `Say` of that command sent
 * on this Connection without a label stands. Nothing says which Message it answers, so that
 * is a guess, and it settles nothing, a `FAIL` included. Anything else, history included,
 * is shown in the Network's own Timeline. Nothing is decided from its description.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 */
const standardReply = (run: Run, arrival: Arrival): void => {
  const { line } = arrival;
  const reply = readReply(line);

  if (reply === undefined) {
    malformed(run, line);

    return;
  }

  if (!arrival.live) {
    reportReply(run, arrival, reply, [{ _tag: "Network" }]);

    return;
  }

  // What labels tie to an intent that refused, or settled, nothing more is shown with it.
  if (arrival.about !== undefined) {
    reportReply(run, arrival, reply, intentWhere(run, arrival.about));

    return;
  }

  const floor = arrival.batch === undefined && !line.tags.has("label");

  if (floor && (toQuery(run, arrival, reply) || toReclaim(run, arrival, reply))) {
    return;
  }

  const looking = floor ? lookupByCommand(run, reply) : undefined;
  const acting = floor ? actionByCommand(run, reply.command) : undefined;

  if (looking !== undefined && (acting === undefined || looking.order < acting.order)) {
    collectFloor(run, looking, line);
  } else if (acting !== undefined && reply.kind === "FAIL") {
    // Refuses its intent once. A later `FAIL` for the same action refuses nothing, and is
    // shown where the action belongs, so none is dropped.
    if (!tieRejection(run, line, acting, reply.code)) {
      reportReply(run, arrival, reply, intentWhere(run, acting.intent));
    }
  } else if (acting === undefined) {
    const said = floor ? latestSayWhere(run, reply.command) : undefined;

    reportReply(run, arrival, reply, said ?? [{ _tag: "Network" }]);
  } else {
    reportReply(run, arrival, reply, intentWhere(run, acting.intent));
  }
};

/**
 * Whether a numeric is shown as it came, before it is read: one that answers neither the
 * `OPER` nor the `CAP LS` the Client sent, and that is not read or reported otherwise.
 * @param run - The step.
 * @param line - The Line, live, and taken by nothing on the floor.
 * @returns Whether it is.
 */
const isShown = (run: Run, line: Line): boolean =>
  isNumeric(line.command) &&
  !unshown.has(line.command) &&
  !answersOper(run, line) &&
  !refusesCap(run, line);

/**
 * A live protocol Line moves the machines on, and a numeric that nothing takes or reports
 * is shown as it came.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @param raw - Its parameters as bytes, when it is the Line that arrived.
 * @param taken - Whether it was taken already: collected for a labelled Lookup, or read as
 * refusing the Client's `MONITOR` or `WATCH`.
 */
const liveLine = (
  run: Run,
  arrival: Arrival,
  raw: readonly RawParam[] | undefined,
  taken: boolean
): void => {
  const { line } = arrival;

  // A numeric no label tied goes to whichever was sent first of the Lookup and the
  // action's Line it names.
  const shown =
    !taken &&
    arrival.answers === undefined &&
    arrival.batch === undefined &&
    !line.tags.has("label") &&
    !floor(run, line) &&
    isShown(run, line);

  // History is reported, and moves no machine: it says what was, not what is.
  protocolLine(run, line, raw);

  // The message of the day is shown whole, once it ends, rather than Line by Line.
  if (shown && !collectMotd(run, arrival)) {
    reportNumeric(run, arrival);
  }
};

/**
 * Does what one Line says, once it has been through the Features' ingress stages.
 * @param run - The step.
 * @param arrival - The Line, as ingress refined it.
 * @param raw - Its parameters as bytes, when it is the Line that arrived.
 */
export const interpret = (
  run: Run,
  arrival: Arrival,
  raw: readonly RawParam[] | undefined
): void => {
  const { line } = arrival;
  const { command } = line;

  const reply = arrival.answers === undefined ? undefined : rejection(line);

  // A refusal of `MONITOR` or `WATCH` itself turns it off for the Connection, whatever else it answers.
  const unmonitored = arrival.live && monitorRefused(run, line);

  if (arrival.answers !== undefined && reply !== undefined) {
    refuseIntent(run, arrival.answers, { _tag: "Rejected", reply });
  }

  // A `366` that ends a listing kept apart from the Channel's own is not read as ending it.
  const apart = endsApart(run, arrival);

  // A Line of a labelled Lookup's reply is collected for it, whatever else it is, so a
  // Message that ends one, such as a lone labelled `NOTICE`, ends it and is still read as
  // a Message below.
  const labelled = collectLabelled(run, arrival);

  if (hasMeaning(command)) {
    means(run, arrival);
    heardCtcp(run, arrival);
  } else if (isStandardReply(command)) {
    // One that refused an intent, or is part of a Lookup's labelled reply, is shown there.
    if (reply === undefined && !labelled) {
      standardReply(run, arrival);
    }
  } else if (arrival.live && isMonitorReply(run, command)) {
    // What `MONITOR` or `WATCH` tells answers no Lookup or action, whatever nick it names.
    monitorReply(run, arrival);
  } else if (arrival.live && !apart) {
    liveLine(run, arrival, raw, labelled || unmonitored);
  }

  endLone(run, arrival);
};
