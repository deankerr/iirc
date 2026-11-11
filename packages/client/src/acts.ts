/**
 * The Owner's actions beyond saying: a topic, a kick, modes, an invite, a nick, away, and
 * a Line written as text. Each is built only through `@iirc/protocol`'s builders, and
 * checked against what the Client knows of the Network, by `CHANTYPES`, `PREFIX`,
 * `CHANMODES`, `MODES`, `TARGMAX`, and the lengths ISUPPORT gives. One that cannot be
 * sent whole, as the Ircd would read and relay it, is refused, and never cut short.
 *
 * What the Ircd says of an action ties to its intent only by structure: by label, where
 * `labeled-response` ties it, and otherwise by an error numeric whose parameters name
 * what one of its Lines named.
 *
 * @packageDocumentation
 */
import { casefold, defaultCasemapping } from "@iirc/protocol/casemapping";
import { limitOf, modesOf, targetLimitsOf } from "@iirc/protocol/isupport";
import {
  away as awayLine,
  encode,
  invite,
  isRejected,
  kick,
  mode,
  nick,
  parse,
  quote,
  topic,
  upperCaseAscii,
} from "@iirc/protocol/line";
import type { Line, OutboundLine, Rejected } from "@iirc/protocol/line";

import type { IntentId } from "./ids.ts";
import type { Action, Input, ModeRequest } from "./input.ts";
import { isSelf, namingNow, rulesNow } from "./meaning.ts";
import { parseChannel, parseNick } from "./names.ts";
import type { ActionWhere, Attempted, ModeChange, RefusedAction } from "./news.ts";
import type { Run } from "./run.ts";
import { folder, ignore, linkOf, refuseIntent, send, updateOpen } from "./run.ts";
import type { Acting, Awaiting } from "./state.ts";
import { maxActing, maxActions } from "./state.ts";
import { openOf, sessionOf } from "./views.ts";

const utf8 = new TextEncoder();

/** RFC 2812's longest nick, assumed until the Ircd announces `NICKLEN`, as registration does. */
const rfcNickLength = 9;

/** The most a Line takes with its line ending, as an Ircd relays it with our source. */
const relayedLimit = 512;

/**
 * The room an Ircd takes for our source when it relays a Line of ours: `:nick!user@host `,
 * guessing a username of 10 bytes and a host of 63 until Self's mask is known.
 * @param run - The step.
 * @returns The bytes it takes.
 */
export const relayed = (run: Run): number => {
  const session = sessionOf(run.state);
  const mask = session?.mask._tag === "Known" ? session.mask.value : undefined;
  const { length } = utf8.encode(session?.nick ?? "");

  return mask === undefined
    ? length + 76
    : 4 + length + utf8.encode(`${mask.user}${mask.host}`).length;
};

/**
 * Whether a Line fits as the Ircd relays it, with our source before it.
 * @param run - The step.
 * @param line - The Line, or why it cannot be built.
 * @returns Whether it can be sent and relayed whole.
 */
const fits = (run: Run, line: OutboundLine | Rejected): line is OutboundLine => {
  const bytes = isRejected(line) ? line : encode(line);

  return !isRejected(line) && !isRejected(bytes) && bytes.length + relayed(run) <= relayedLimit;
};

const tokenOf = (run: Run, name: string): string | undefined =>
  openOf(run.state)?.isupport.get(name);

// Lengths count UTF-8 bytes, which an Ircd that counts characters never exceeds, so no
// Ircd cuts short what fits.
const within = (run: Run, token: string, text: string, fallback?: number): boolean => {
  const limit = limitOf(tokenOf(run, token)) ?? fallback;

  return limit === undefined || utf8.encode(text).length <= limit;
};

/**
 * One Line of an action: what the whole Line is about, its targets, each answered by
 * itself, and for an `AWAY`, the message it sends, or `null` for none.
 */
interface Planned {
  readonly line: OutboundLine;
  readonly names: readonly string[];
  readonly targets: readonly Awaiting[];
  readonly away?: string | null;
}

const one = (run: Run, line: OutboundLine | Rejected, names: readonly string[]) =>
  fits(run, line) ? [{ line, names, targets: [] }] : undefined;

const isChannel = (run: Run, name: string): boolean =>
  parseChannel(namingNow(run), name) !== undefined;

const isNick = (run: Run, name: string): boolean => parseNick(namingNow(run), name) !== undefined;

type Of<Tag extends Action["_tag"]> = Extract<Action, { readonly _tag: Tag }>;

const topicLines = (run: Run, { channel, text }: Of<"Topic">) =>
  isChannel(run, channel) && within(run, "TOPICLEN", text)
    ? one(run, topic(channel, text), [channel])
    : undefined;

const inviteLines = (run: Run, { nick: name, channel }: Of<"Invite">) =>
  isChannel(run, channel) && isNick(run, name)
    ? one(run, invite(name, channel), [name, channel])
    : undefined;

const nickLines = (run: Run, { nick: name }: Of<"Nick">) =>
  isNick(run, name) && within(run, "NICKLEN", name, rfcNickLength)
    ? one(run, nick(name), [name])
    : undefined;

/**
 * Splits items into Lines, as many to a Line as fit and as `limit` allows, keeping their
 * order. An item that fits no Line alone leaves nothing to send.
 * @param items - The items.
 * @param limit - The most items that count towards it, to a Line, or `undefined` for no limit.
 * @param counts - Whether an item counts towards the limit.
 * @param build - Builds one Line of items.
 * @returns The Lines, or `undefined` when an item fits none.
 */
const split = <T>(
  items: readonly T[],
  limit: number | undefined,
  counts: (item: T) => boolean,
  build: (items: readonly T[]) => Planned | undefined
): readonly Planned[] | undefined => {
  const lines: Planned[] = [];
  let batch: T[] = [];

  for (const item of items) {
    const longer = [...batch, item];
    const counted = longer.filter(counts).length;
    const built = limit !== undefined && counted > limit ? undefined : build(longer);

    if (built !== undefined) {
      batch = longer;
      continue;
    }

    const flushed = batch.length === 0 ? undefined : build(batch);
    const alone = build([item]);

    if (flushed === undefined || alone === undefined) {
      return undefined;
    }

    lines.push(flushed);
    batch = [item];
  }

  const last = batch.length === 0 ? undefined : build(batch);

  return last === undefined ? undefined : [...lines, last];
};

// `TARGMAX` lists how many nicks a `KICK` takes. A command it does not list, or no
// `TARGMAX` at all, takes one, as RFC 1459 has it.
const kickLines = (run: Run, { channel, nicks, reason }: Of<"Kick">) => {
  const limits = targetLimitsOf(tokenOf(run, "TARGMAX"));
  const limit = limits.has("KICK") ? limits.get("KICK") : 1;
  const said = reason ?? undefined;

  const valid =
    isChannel(run, channel) &&
    nicks.every((name) => isNick(run, name)) &&
    within(run, "KICKLEN", said ?? "");

  return valid
    ? split(
        nicks,
        limit,
        () => true,
        (some) => {
          const line = kick(channel, some, said);

          return fits(run, line)
            ? { line, names: [channel], targets: some.map((name) => ({ mode: undefined, name })) }
            : undefined;
        }
      )
    : undefined;
};

/** How a Channel mode takes a parameter, by `PREFIX` and `CHANMODES`. */
type Takes = "Always" | "WhenSet" | "Never";

const takesOf = (run: Run, letter: string): Takes | undefined => {
  const rules = rulesNow(run);
  const { list, always, whenSet, flags } = rules.channel;

  if (rules.prefix.some((membership) => membership.mode === letter)) {
    return "Always";
  }

  if (list.includes(letter) || always.includes(letter)) {
    return "Always";
  }

  if (whenSet.includes(letter)) {
    return "WhenSet";
  }

  return flags.includes(letter) ? "Never" : undefined;
};

// A mode is one printable ASCII character that is not a sign, a separator, or a
// parameter's colon.
const isModeLetter = (letter: string): boolean =>
  /^[\u0021-\u007E]$/u.test(letter) && !/[+\-:,]/u.test(letter);

// Whether a Channel's mode change carries a parameter exactly when `PREFIX` and
// `CHANMODES` say it must.
const fitsRules = (run: Run, change: ModeRequest): boolean => {
  const takes = isModeLetter(change.mode) ? takesOf(run, change.mode) : undefined;
  const needs = takes === "Always" || (takes === "WhenSet" && change.set);

  return takes !== undefined && needs === (change.param !== null);
};

// A mode change awaiting its answer: its sign and letter, and its parameter, if any.
const awaitingOf = (change: ModeRequest): Awaiting => ({
  mode: `${change.set ? "+" : "-"}${change.mode}`,
  name: change.param ?? undefined,
});

// The mode string and its parameters, with each sign written once for a run of changes.
const modeArgs = (changes: readonly ModeRequest[]): readonly string[] => {
  let modes = "";
  let sign: boolean | undefined;

  for (const change of changes) {
    if (change.set !== sign) {
      modes += change.set ? "+" : "-";
      sign = change.set;
    }

    modes += change.mode;
  }

  return [modes, ...changes.flatMap((change) => (change.param === null ? [] : [change.param]))];
};

// A Channel's modes split across Lines by `MODES`, which counts the changes that take a
// parameter. Self's own modes are not a Channel's, so `MODES` does not count them, and a
// parameter goes as the Owner gave it.
const modeLines = (run: Run, { target, changes }: Of<"Mode">) => {
  const channel = isChannel(run, target);

  const valid =
    changes.every((change) => isModeLetter(change.mode)) &&
    (channel ? changes.every((change) => fitsRules(run, change)) : isSelf(run, target));

  return valid
    ? split(
        changes,
        channel ? modesOf(tokenOf(run, "MODES")) : undefined,
        (change) => change.param !== null,
        (some) => {
          const args = modeArgs(some);
          const line = mode(target, args);

          return fits(run, line)
            ? { line, names: [target], targets: some.map(awaitingOf) }
            : undefined;
        }
      )
    : undefined;
};

/**
 * Commands a Line written as text may not carry. Cap negotiation is the Client's own,
 * and an `ACK` it did not ask for is ignored, so the Ircd and the Client would disagree.
 * `PASS`, `AUTHENTICATE`, and `OPER` carry a Credential, and a Line written as text is
 * journaled as it was written.
 */
const unquotable: ReadonlySet<string> = new Set(["AUTHENTICATE", "CAP", "OPER", "PASS"]);

// Only client-only tags may go on a Line written as text. `label` and `batch` are the
// Client's own, which it ties answers by.
/**
 * Whether a raw `JOIN` or `PART` names a Channel the Configuration wants, which joining
 * and parting through Configuration own: a raw `PART` of one would be undone as a kick
 * is, and a raw `JOIN 0` leaves every one. A raw `JOIN` of a Channel the Configuration
 * does not want is followed as one Self was put in without asking.
 * @param run - The step.
 * @param line - The Line, as read.
 * @returns Whether it does.
 */
const touchesWanted = (run: Run, line: Line): boolean => {
  const [names = ""] = line.params;
  const fold = folder(run.state);
  const wanted = [...run.state.channels.values()].filter((channel) => channel.wanted);

  if (line.command !== "JOIN" && line.command !== "PART") {
    return false;
  }

  if (line.command === "JOIN" && names === "0") {
    return wanted.length > 0;
  }

  return names
    .split(",")
    .some((name) => name !== "" && run.state.channels.get(fold(name))?.wanted === true);
};

const rawLines = (run: Run, { line: text }: Of<"Raw">): readonly Planned[] | undefined => {
  const line = quote(text);
  const read = parse(utf8.encode(text), { _tag: "Utf8Only" });

  if (
    isRejected(line) ||
    read._tag === "Unparseable" ||
    unquotable.has(line.command) ||
    touchesWanted(run, read.line) ||
    !Object.keys(line.tags).every((key) => key.startsWith("+"))
  ) {
    return undefined;
  }

  // An `AWAY` sent this way is one a `306` confirms, as any other.
  const [message = ""] = read.line.params;

  return [
    line.command === "AWAY"
      ? { away: message === "" ? null : message, line, names: [], targets: [] }
      : { line, names: [], targets: [] },
  ];
};

const plan = (
  run: Run,
  action: Exclude<Action, { readonly _tag: "Away" }>
): readonly Planned[] | undefined => {
  switch (action._tag) {
    case "Topic": {
      return topicLines(run, action);
    }

    case "Kick": {
      return kickLines(run, action);
    }

    case "Mode": {
      return modeLines(run, action);
    }

    case "Invite": {
      return inviteLines(run, action);
    }

    case "Nick": {
      return nickLines(run, action);
    }

    case "Raw": {
      return rawLines(run, action);
    }

    default: {
      return action satisfies never;
    }
  }
};

/**
 * Whether Lines can go to the Ircd now: in a Session, not hanging up, and not shutting
 * down.
 * @param run - The step.
 * @returns Whether they can.
 */
export const online = (run: Run): boolean =>
  sessionOf(run.state) !== undefined && linkOf(run)?.closing === undefined && !run.state.stopping;

/**
 * What an action tried, in short: its kind and the names the Owner gave it, never its
 * text, a mode's parameter, or the rest of a raw Line.
 * @param action - The action.
 * @returns What it tried.
 */
const attemptedOf = (action: Action): Attempted => {
  switch (action._tag) {
    case "Topic": {
      return { _tag: "Topic", channel: action.channel };
    }

    case "Kick": {
      return { _tag: "Kick", channel: action.channel, nicks: action.nicks };
    }

    case "Mode": {
      const [modes = ""] = modeArgs(action.changes.map((change) => ({ ...change, param: null })));

      return { _tag: "Mode", modes, target: action.target };
    }

    case "Invite": {
      return { _tag: "Invite", channel: action.channel, nick: action.nick };
    }

    case "Nick": {
      return { _tag: "Nick", nick: action.nick };
    }

    case "Away": {
      return { _tag: "Away", away: action.message !== null && action.message !== "" };
    }

    case "Raw": {
      const line = quote(action.line);

      return { _tag: "Raw", command: isRejected(line) ? null : line.command };
    }

    default: {
      return action satisfies never;
    }
  }
};

/**
 * Where an action belongs: the Channel it is about, when the Client holds that Channel,
 * wanted or joined, keyed as `where` keys it, and otherwise the Network's own Timeline. A
 * nick, away, a raw Line, and Self's own modes belong to the Network.
 * @param run - The step.
 * @param action - The action.
 * @returns Where it belongs.
 */
const actionWhere = (run: Run, action: Action): ActionWhere => {
  let name: string | undefined;

  if (action._tag === "Topic" || action._tag === "Kick" || action._tag === "Invite") {
    name = action.channel;
  } else if (action._tag === "Mode") {
    name = action.target;
  }

  if (
    name === undefined ||
    !isChannel(run, name) ||
    !run.state.channels.has(folder(run.state)(name))
  ) {
    return { _tag: "Network" };
  }

  return { _tag: "Channel", key: casefold(run.state.declared ?? defaultCasemapping, name), name };
};

const actionOf = (run: Run, action: Action): RefusedAction => ({
  attempted: attemptedOf(action),
  where: actionWhere(run, action),
});

// Remembers an action that is about to leave, so a refusal that comes later says where it
// belongs. The oldest is forgotten past the bound.
const remember = (run: Run, intent: IntentId, action: Action): void => {
  const actions = new Map(run.state.actions).set(intent, actionOf(run, action));

  for (const oldest of actions.keys()) {
    if (actions.size <= maxActions) {
      break;
    }

    actions.delete(oldest);
  }

  run.state = { ...run.state, actions };
};

const refuse = (
  run: Run,
  intent: IntentId,
  action: Action,
  reason: "Offline" | "Unsendable"
): void => {
  run.news.push({
    _tag: "Refused",
    action: actionOf(run, action),
    intent,
    reason: { _tag: reason },
  });
};

// Keeps a Line of an action, so an error numeric that names what it names can be tied
// to its intent. The oldest is forgotten past the bound.
const awaitAnswer = (
  run: Run,
  intent: IntentId,
  line: OutboundLine,
  names: readonly string[],
  targets: readonly Awaiting[]
) => {
  const acting: Acting = { command: line.command, intent, names, reported: false, targets };

  updateOpen(run, (open) => ({ ...open, acting: [...open.acting, acting].slice(-maxActing) }));
};

// An `AWAY` went out with a message, or `null` for none: a `306` confirms it.
const asked = (run: Run, message: string | null): void => {
  updateOpen(run, (open) => ({ ...open, asked: message }));
};

/**
 * Sends the Owner's away message as a Session begins, when the Owner is away. A message
 * the Network cannot carry is not sent, and is `Ignored` as `Unsendable`.
 * @param run - The step.
 */
export const resendAway = (run: Run): void => {
  const { away } = run.state;

  if (away === undefined) {
    return;
  }

  const line = awayLine(away);

  if (!fits(run, line)) {
    ignore(run, { _tag: "Unsendable", command: "AWAY" });

    return;
  }

  if (send(run, line, "AWAY") !== undefined) {
    asked(run, away);
  }
};

// Away describes the Owner, so it is kept whether or not a Session is up, and each
// Session begins by sending it again. In a Session, it is sent now, if the Network can
// carry it.
const away = (run: Run, intent: IntentId, action: Of<"Away">): void => {
  const { message } = action;
  const wanted = message === null || message === "" ? undefined : message;
  const line = awayLine(wanted);
  const now = online(run);

  if (isRejected(line) || (now && (!within(run, "AWAYLEN", wanted ?? "") || !fits(run, line)))) {
    refuse(run, intent, action, "Unsendable");

    return;
  }

  run.state = { ...run.state, away: wanted };

  if (now) {
    remember(run, intent, action);
  }

  if (now && send(run, line, "AWAY", { _tag: "Acted", intent }) !== undefined) {
    asked(run, wanted ?? null);
  }
};

/**
 * The Owner acts on the Network. Away is kept at any time. Anything else needs a
 * Session, and is `Refused` as `Offline` without one, or as `Unsendable` when it cannot
 * be sent whole. Every Line of it carries its intent.
 * @param run - The step.
 * @param input - The action.
 */
export const act = (run: Run, input: Input & { readonly _tag: "Act" }): void => {
  const { action, intent } = input;

  if (action._tag === "Away") {
    away(run, intent, action);

    return;
  }

  if (!online(run)) {
    refuse(run, intent, action, "Offline");

    return;
  }

  const planned = plan(run, action);

  if (planned === undefined) {
    refuse(run, intent, action, "Unsendable");

    return;
  }

  remember(run, intent, action);

  for (const { line, names, targets, away: message } of planned) {
    const sent = send(run, line, line.command, { _tag: "Acted", intent });

    // A Feature refused it at egress, and `send` reported it.
    if (sent === undefined) {
      return;
    }

    if (message !== undefined) {
      asked(run, message);
    }

    if (!sent.echo) {
      awaitAnswer(run, intent, line, names, targets);
    }
  }
};

/** How an error numeric names what it refuses: the commands it answers, and which parameters name. */
interface Tie {
  readonly commands: ReadonlySet<string>;
  readonly params: readonly number[];
}

const onChannels: ReadonlySet<string> = new Set(["INVITE", "KICK", "MODE", "TOPIC"]);
const nicks: Tie = { commands: new Set(["NICK"]), params: [1] };

/**
 * The error numerics tied to an action by their parameters, as Modern IRC gives them.
 * `421` and `461` name a command instead, and are read apart.
 */
const ties: ReadonlyMap<string, Tie> = new Map([
  // `401 <client> <nick>`
  ["401", { commands: new Set(["INVITE", "KICK", "MODE"]), params: [1] }],
  // `403`, `442`, `476`, and `482 <client> <channel>`
  ["403", { commands: onChannels, params: [1] }],
  ["442", { commands: onChannels, params: [1] }],
  ["476", { commands: onChannels, params: [1] }],
  ["482", { commands: onChannels, params: [1] }],
  // `467 <client> <channel>`: a key is already set.
  ["467", { commands: new Set(["MODE"]), params: [1] }],
  // `441 <client> <nick> <channel>`
  ["441", { commands: new Set(["KICK", "MODE"]), params: [1, 2] }],
  // `443 <client> <nick> <channel>`
  ["443", { commands: new Set(["INVITE"]), params: [1, 2] }],
  // `432`, `433`, `436`, and `437 <client> <nick>`
  ["432", nicks],
  ["433", nicks],
  ["436", nicks],
  ["437", nicks],
]);

// The Line at `index` with what an answer resolved: one target, at `target`, or with
// none, the whole Line. A Line with no target left is no longer awaited. Once one of an
// intent's Lines is refused, every other is marked so it is never reported again.
const resolve = (
  acting: readonly Acting[],
  index: number,
  target: number | undefined,
  refused: boolean
): readonly Acting[] => {
  const at = acting[index];

  if (at === undefined) {
    return acting;
  }

  const left = at.targets.filter((_each, place) => place !== target);
  const whole = target === undefined || left.length === 0;

  return acting.flatMap((each, place) => {
    if (place === index) {
      return whole ? [] : [{ ...each, reported: each.reported || refused, targets: left }];
    }

    return refused && each.intent === at.intent ? [{ ...each, reported: true }] : [each];
  });
};

/**
 * Ties an error numeric to the oldest Line of an action it names, and reports the action
 * `Rejected` with the numeric, once for its intent. It reads the numeric's parameters
 * only: a Channel or nick, as each numeric places them, or for `421` and `461`, a command.
 * Names are compared folded by the Connection's casemapping now. A numeric that names one
 * of a Line's targets, such as `441` a nick of a `KICK`, answers one occurrence of that
 * target alone, and one that names only what the Line is about, such as `482` its
 * Channel, answers the whole Line.
 * @param run - The step.
 * @param line - The Line, live and tied to nothing by label.
 */
export const tieRejection = (run: Run, line: Line): void => {
  const open = openOf(run.state);
  const { command, params } = line;
  const tie = ties.get(command);
  const named = command === "421" || command === "461";

  if (open === undefined || open.acting.length === 0 || (tie === undefined && !named)) {
    return;
  }

  const fold = folder(run.state);
  const said = tie?.params.map((index) => params[index]) ?? [];
  const names = said.flatMap((name) => (name === undefined ? [] : [fold(name)]));
  const verb = named ? upperCaseAscii(params[1] ?? "") : "";

  if (names.length !== said.length) {
    return;
  }

  const holds = (each: Acting, name: string) =>
    each.names.some((one) => fold(one) === name) ||
    each.targets.some((target) => target.name !== undefined && fold(target.name) === name);

  const index = open.acting.findIndex((each) =>
    named
      ? each.command === verb
      : tie?.commands.has(each.command) === true && names.every((name) => holds(each, name))
  );

  const tied = open.acting[index];

  if (tied === undefined) {
    return;
  }

  if (!tied.reported) {
    refuseIntent(run, tied.intent, { _tag: "Rejected", reply: command });
  }

  const target = tied.targets.findIndex(
    (each) => each.name !== undefined && names.includes(fold(each.name))
  );

  updateOpen(run, (phase) => ({
    ...phase,
    acting: resolve(phase.acting, index, target === -1 ? undefined : target, true),
  }));
};

/** What a success answers: one target of a Line, as `matches` finds it, or a Line with none. */
type Answer = ((target: Awaiting, fold: (name: string) => string) => boolean) | undefined;

/**
 * The Ircd did what a Line of an action asked, as a `TOPIC`, `KICK`, `MODE`, or `NICK`
 * from Self, or a `341`, shows. With `matches`, it answers the first target it matches of
 * the oldest Line of that command about these names, one occurrence, and the Line is
 * awaited until each target is answered. Without, it answers the oldest such Line that
 * has no target. Names are compared folded by the Connection's casemapping now.
 * @param run - The step.
 * @param command - The command it was sent as.
 * @param names - What the whole Line is about.
 * @param matches - Which target it answers, if any.
 */
export const answered = (
  run: Run,
  command: string,
  names: readonly string[],
  matches?: Answer
): void => {
  const open = openOf(run.state);

  if (open === undefined || open.acting.length === 0) {
    return;
  }

  const fold = folder(run.state);
  const folded = names.map(fold);

  const about = (each: Acting) =>
    each.command === command &&
    each.names.length === folded.length &&
    each.names.every((name) => folded.includes(fold(name)));

  const targetOf = (each: Acting) =>
    matches === undefined ? -1 : each.targets.findIndex((target) => matches(target, fold));

  const index = open.acting.findIndex(
    (each) =>
      about(each) && (matches === undefined ? each.targets.length === 0 : targetOf(each) !== -1)
  );

  const answering = open.acting[index];

  if (answering !== undefined) {
    const target = targetOf(answering);

    updateOpen(run, (phase) => ({
      ...phase,
      acting: resolve(phase.acting, index, target === -1 ? undefined : target, false),
    }));
  }
};

/**
 * A nick a `KICK` from Self names answers one occurrence of it.
 * @param nick - The nick.
 * @returns What it answers.
 */
export const nickAnswer =
  (nick: string): Answer =>
  (target, fold) =>
    target.name !== undefined && fold(target.name) === fold(nick);

/**
 * A mode change a `MODE` from Self makes answers one change awaited with the same sign and
 * letter. An Ircd may rewrite a parameter, as a ban mask, or never show it, as a key, so
 * only a membership mode, whose nick comes back as sent, must name the same parameter.
 * @param change - The change, as the Ircd made it.
 * @param membership - Whether its mode is a membership mode, by `PREFIX`.
 * @returns What it answers.
 */
export const modeAnswer =
  (change: ModeChange, membership: boolean): Answer =>
  (target, fold) =>
    target.mode === `${change.set ? "+" : "-"}${change.mode}` &&
    (!membership ||
      (target.name !== undefined &&
        change.param !== undefined &&
        fold(target.name) === fold(change.param)));
