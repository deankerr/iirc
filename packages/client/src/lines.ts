/**
 * What each received Line does, once ingress has refined it: protocol Lines move the
 * machines on, and Lines with meaning go through the `meaning` stage and are folded into
 * the model and reported.
 *
 * @packageDocumentation
 */
import { casemappingOf, defaultCasemapping } from "@iirc/protocol/casemapping";
import { isupportTokens } from "@iirc/protocol/isupport";
import { parseSource, pong } from "@iirc/protocol/line";
import type { Line, RawParam } from "@iirc/protocol/line";

import { answered, modeAnswer, nickAnswer, resendAway, tiedAction, tieRejection } from "./acts.ts";
import {
  changeJoined,
  endOfNames,
  foldActivity,
  foldListed,
  joinWanted,
  remap,
  refused,
  see,
} from "./channels.ts";
import type { Arrival, Meant } from "./feature.ts";
import { Instant } from "./ids.ts";
import { collectFloor, collectLabelled, floorLookup } from "./lookups.ts";
import { followRenames, refoldMarkers } from "./markers.ts";
import { channelTest, derive, hasMeaning, isSelf, rulesNow, unfit } from "./meaning.ts";
import { applyModes, readModes } from "./modes.ts";
import type { Activity, ModeChange } from "./news.ts";
import {
  abandon,
  capLine,
  loginOwed,
  carryOutRefined,
  nickRefused,
  offered,
  unknownCommand,
  welcomed,
} from "./registration.ts";
import type { Run } from "./run.ts";
import { ignore, linkOf, readingOf, refuseIntent, send, updateOpen } from "./run.ts";
import { runStage } from "./seam.ts";
import { maxConfirmed } from "./state.ts";
import { lagAfter } from "./timers.ts";
import { onNow, openOf, sessionOf } from "./views.ts";
import { routeActivity, routeMessage } from "./where.ts";

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
    routeActivity(run, {
      _tag: "Activity",
      activity: { _tag: "AwayChanged", away, nick },
      at: { _tag: "Known", at: run.at, from: "receipt", value: run.at },
      id: { _tag: "Unknown" },
      live: true,
    })
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

// What Self did, live, answers the Line of an action that asked for it, and Self's own
// `AWAY` says whether Self is away.
const settled = (run: Run, activity: Activity): void => {
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

    case "ModeChanged": {
      if (isSelf(run, activity.by)) {
        modesAnswered(run, activity.target, activity.changes);
      }

      break;
    }

    case "NickChanged": {
      if (isSelf(run, activity.from)) {
        answered(run, "NICK", [activity.to]);
      }

      break;
    }

    case "AwayChanged": {
      if (isSelf(run, activity.nick)) {
        selfAway(run, activity.away);
      }

      break;
    }

    case "Joined":
    case "Parted":
    case "Quit": {
      break;
    }

    default: {
      activity satisfies never;
    }
  }
};

const none: ReadonlySet<string> = new Set();

const memberKey = (channel: string, nick: string): string => `${channel} ${nick}`;

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

// Folds what a Line meant into the model, and reports it. History is reported, and
// never changes what is known now.
const fold = (
  run: Run,
  meant: Meant,
  arrival: Arrival,
  completed: ReadonlySet<string> = none
): void => {
  const { line, live } = arrival;

  if (meant._tag === "Listed") {
    if (live) {
      foldListed(run, meant.channel, meant.members, (nick) =>
        completed.has(memberKey(meant.channel, nick))
      );
    }

    return;
  }

  const source = line.source === undefined ? undefined : parseSource(line.source);

  // Where it belongs is worked out before it changes what is known, so a Quit lists the
  // Channels the User was in.
  if (meant._tag === "Message") {
    run.news.push(routeMessage(run, meant, source));
  } else if (meant._tag === "Activity") {
    const routed = routeActivity(run, meant);

    run.news.push(routed);
    followRenames(run, routed.where);
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
  foldActivity(run, activity, rulesNow(run), channelTest(run));

  if (selfRenamed) {
    updateOpen(run, (open) =>
      open.presence._tag === "Session"
        ? { ...open, presence: { ...open.presence, nick: activity.to } }
        : open
    );
  }

  const { user, host } = source ?? {};

  if (source === undefined || user === undefined || host === undefined) {
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
      keepalive: { check: Instant.make(run.at + lagAfter), heard: run.at, pinged: false },
      // `001`'s text is for people. Self's mask waits for a structured source, such as
      // the echo of our own `JOIN`.
      mask: { _tag: "Unknown" },
      nick,
      realname: { _tag: "Known", at: phase.opened, from: "ours", value: realname },
      server: line.source ?? link.ircd.host,
    },
  }));
  run.news.push({ _tag: "SessionBegan", at: run.at, nick });
  // The Owner's away outlives Sessions: each begins by saying it again.
  resendAway(run);
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

// `332 <client> <channel> :<topic>`, `331 <client> <channel>`, and
// `333 <client> <channel> <who> <when>`. Replies to our `JOIN` are said as it happened.
const topicReply = (run: Run, line: Line): void => {
  const [, channel, third, fourth] = line.params;

  if (channel === undefined || (line.command !== "331" && third === undefined)) {
    malformed(run, line);

    return;
  }

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
  ["331", topicReply],
  ["332", topicReply],
  ["333", topicReply],
  ["324", channelModes],
  [
    "366",
    (run, line) => {
      second(run, line, (name) => {
        endOfNames(run, name);
      });
    },
  ],
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
 * floor: a Lookup whose reply it can be part of, or an action's Line whose error it
 * names, by the order they were sent.
 * @param run - The step.
 * @param line - The Line, live, outside any batch, and with no label.
 */
const floor = (run: Run, line: Line): void => {
  const looking = floorLookup(run, line);
  const tied = tiedAction(run, line);

  if (looking !== undefined && (tied === undefined || looking.order < tied.order)) {
    collectFloor(run, looking, line);
  } else if (tied !== undefined) {
    tieRejection(run, line, tied);
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

  if (arrival.answers !== undefined && reply !== undefined) {
    refuseIntent(run, arrival.answers, { _tag: "Rejected", reply });
  }

  // A Line of a labelled Lookup's reply is collected for it, whatever else it is, so a
  // Message that ends one, such as a lone labelled `NOTICE`, ends it and is still read as
  // a Message below.
  const labelled = collectLabelled(run, arrival);

  if (hasMeaning(command)) {
    means(run, arrival);
  } else if (arrival.live) {
    // A numeric no label tied goes to whichever was sent first of the Lookup and the
    // action's Line it names.
    if (
      !labelled &&
      arrival.answers === undefined &&
      arrival.batch === undefined &&
      !line.tags.has("label")
    ) {
      floor(run, line);
    }

    // History is reported, and moves no machine: it says what was, not what is.
    protocolLine(run, line, raw);
  }
};
