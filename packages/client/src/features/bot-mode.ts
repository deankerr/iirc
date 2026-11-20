/**
 * `BOT`, an ISUPPORT token: the Ircd lets a User mark themselves as a bot with the user
 * mode it names, shows that mode among a bot's `WHO` flags, and may tag a bot's Lines
 * with `bot`. A value that is not exactly one letter offers nothing, so the Feature then
 * marks no one and sets no mode.
 *
 * - **The tag.** A User's Line that means a Message or an Activity, with the `bot` tag, of
 *   any value or none, says they are a bot, and a Message it carries is marked as a bot's.
 *   While the Session carries tags, a User's such Line without it says they are not.
 *   Without tags, its absence says nothing.
 * - **Self's mode.** A `MODE` on Self that sets or unsets the bot mode says whether Self is
 *   one. There is no other tracking of Self's user modes.
 * - **Saying Self is a bot.** Where the Configuration says `bot`, Self sets the mode with
 *   one `MODE` once a Session has begun and the token is known: when the Feature turns on,
 *   since ISUPPORT follows the welcome, or on the first Line after the welcome, for an Ircd
 *   that named it before. It is sent once a Connection: the token sent again, or taken away
 *   and given back, sends nothing more. A Configuration changed during a Session waits for
 *   the next one.
 *
 * `WHO` flags and `WHOIS`'s `335` are read by the core, while this Feature keeps `user.bot`.
 *
 * @packageDocumentation
 */
import { casefold } from "@iirc/protocol/casemapping";
import { botModeOf } from "@iirc/protocol/isupport";
import { isRejected, mode } from "@iirc/protocol/line";

import type { Context, Effects, Feature, Meant } from "../feature.ts";
import { FeatureName } from "../ids.ts";
import { afterwards, userSource } from "./user-source.ts";

/** The Feature's own state: whether Self's bot mode was asked for on this Connection. */
interface Own {
  readonly asked: boolean;
}

// Self sets the bot mode, once a Connection, where the Configuration says so and a
// Session has begun.
const askOnce = (context: Context<Own>): Effects<Own> => {
  const letter = botModeOf(context.token("BOT"));
  const { self, session } = context.known;

  if (
    context.own.asked ||
    !context.configuration.bot ||
    letter === undefined ||
    session._tag !== "Registered" ||
    self === undefined
  ) {
    return {};
  }

  const line = mode(self.nick, [`+${letter}`]);

  return isRejected(line) ? {} : { own: { asked: true }, send: [{ _tag: "Line", line }] };
};

// Whether a Self's `MODE` sets or unsets the bot mode, by its last change of it.
const selfMode = (
  meant: readonly Meant[],
  letter: string,
  context: Context<Own>
): boolean | undefined => {
  const { casemapping, self } = context.known;
  let bot: boolean | undefined;

  for (const each of meant) {
    if (
      self !== undefined &&
      each._tag === "Activity" &&
      each.activity._tag === "ModeChanged" &&
      casefold(casemapping, each.activity.target) === casefold(casemapping, self.nick)
    ) {
      for (const change of each.activity.changes) {
        if (change.mode === letter) {
          bot = change.set;
        }
      }
    }
  }

  return bot;
};

/** The `bot-mode` Feature. */
export const botMode: Feature<Own> = {
  keeps: ["user.bot"],
  meaning: (meant, arrival, context) => {
    const letter = botModeOf(context.token("BOT"));

    if (letter === undefined) {
      return { value: meant };
    }

    const tagged = arrival.line.tags.has("bot");

    const marked = meant.map((each) =>
      tagged && each._tag === "Message" ? { ...each, bot: true } : each
    );

    const source = userSource(arrival.line);
    const said = meant.some((each) => each._tag === "Message" || each._tag === "Activity");
    const { session } = context.known;
    const tags = session._tag === "Registered" && session.tags;

    const byTag: readonly Meant[] =
      source !== undefined && said && (tagged || tags)
        ? [{ _tag: "Described", bot: tagged, nick: afterwards(meant, source.nick) }]
        : [];

    const set = selfMode(meant, letter, context);
    const self = context.known.self?.nick;

    // Self's own `MODE` is the latest word on Self, after what its tag said.
    const byMode: readonly Meant[] =
      set === undefined || self === undefined ? [] : [{ _tag: "Described", bot: set, nick: self }];

    return { value: [...marked, ...byTag, ...byMode] };
  },
  name: FeatureName.make("bot-mode"),
  needs: { tokens: ["BOT"] },
  own: { asked: false },
  react: (_arrival, context) => askOnce(context),
  start: askOnce,
};
