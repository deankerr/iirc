/**
 * What each received Line does, once ingress has refined it: protocol Lines move the
 * machines on, and Lines with meaning go through the `meaning` stage and are folded into
 * the model and reported.
 *
 * @packageDocumentation
 */
import { casemappingOf } from "@iirc/protocol/casemapping";
import { isupportTokens } from "@iirc/protocol/isupport";
import { parseSource, pong } from "@iirc/protocol/line";
import type { Line, RawParam } from "@iirc/protocol/line";

import {
  changeJoined,
  endOfNames,
  foldActivity,
  foldListed,
  joinWanted,
  refold,
  refused,
  see,
} from "./channels.ts";
import type { Arrival, Meant } from "./feature.ts";
import { Instant } from "./ids.ts";
import { channelTest, derive, hasMeaning, isSelf, rulesNow, unfit } from "./meaning.ts";
import { applyModes, readModes } from "./modes.ts";
import {
  capLine,
  carryOut,
  nickRefused,
  offered,
  unknownCommand,
  welcomed,
} from "./registration.ts";
import type { Run } from "./run.ts";
import { folder, ignore, linkOf, readingOf, send, updateOpen } from "./run.ts";
import { runStage } from "./seam.ts";
import { lagAfter } from "./timers.ts";
import { onNow, openOf } from "./views.ts";

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

// Folds what a Line meant into the model, and reports it.
const fold = (run: Run, meant: Meant, line: Line): void => {
  if (meant._tag === "Listed") {
    foldListed(run, meant.channel, meant.members);

    return;
  }

  run.news.push(meant);

  if (meant._tag !== "Activity") {
    return;
  }

  const { activity } = meant;
  const selfRenamed = activity._tag === "NickChanged" && isSelf(run, activity.from);

  foldActivity(run, activity, rulesNow(run), channelTest(run));

  if (selfRenamed) {
    updateOpen(run, (open) =>
      open.presence._tag === "Session"
        ? { ...open, presence: { ...open.presence, nick: activity.to } }
        : open
    );
  }

  const source = line.source === undefined ? undefined : parseSource(line.source);
  const { user, host } = source ?? {};

  if (source === undefined || user === undefined || host === undefined) {
    return;
  }

  if (isSelf(run, source.nick)) {
    ownMask(run, user, host);
  } else if (activity._tag === "Joined" || activity._tag === "NickChanged") {
    see(run, activity._tag === "Joined" ? source.nick : activity.to, (seen) => ({
      ...seen,
      mask: { at: run.at, host, user },
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

    carryOut(run, ran);

    for (const each of ran.value) {
      fold(run, each, arrival.line);
    }

    return;
  }

  for (const each of derived) {
    fold(run, each, arrival.line);
  }
};

// Self's mask from `001`'s last word, where an Ircd ends its welcome with `nick!user@host`.
const welcomeMask = (run: Run, line: Line, nick: string) => {
  const last = line.params.length >= 2 ? (line.params.at(-1)?.split(" ").at(-1) ?? "") : "";
  const shown = parseSource(last);
  const fold = folder(run.state);

  return shown.user !== undefined && shown.host !== undefined && fold(shown.nick) === fold(nick)
    ? ({
        _tag: "Known",
        at: run.at,
        from: "ircd",
        value: { host: shown.host, user: shown.user },
      } as const)
    : ({ _tag: "Unknown" } as const);
};

const welcome = (run: Run, line: Line): void => {
  const open = openOf(run.state);
  const link = linkOf(run);

  if (open === undefined || link === undefined || open.presence._tag !== "Registering") {
    ignore(run, { _tag: "NotNow", input: "Received" });

    return;
  }

  const { account } = open.presence;
  const [first] = line.params;
  const nick = first ?? offered(run) ?? run.state.configuration?.nicks[0] ?? "*";

  welcomed(run);
  updateOpen(run, (phase) => ({
    ...phase,
    presence: {
      _tag: "Session",
      account,
      began: run.at,
      keepalive: { check: Instant.make(run.at + lagAfter), heard: run.at, pinged: false },
      mask: welcomeMask(run, line, nick),
      nick,
      server: line.source ?? link.ircd.host,
    },
  }));
  run.news.push({ _tag: "SessionBegan", at: run.at, nick });
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

  if (mapping !== run.state.casemapping) {
    run.state = { ...run.state, casemapping: mapping };
    refold(run);
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
    "901",
    (run) => {
      account(run, null);
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

  if (arrival.answers !== undefined && /^[45]\d\d$/u.test(command)) {
    run.news.push({
      _tag: "Refused",
      intent: arrival.answers,
      reason: { _tag: "Rejected", reply: command },
    });
  }

  if (hasMeaning(command)) {
    means(run, arrival);
  } else if (refusals.has(command) || (command === "437" && !isRegistering(run))) {
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
