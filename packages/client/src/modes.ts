/**
 * Reading mode changes, and members' prefixes, by the rules ISUPPORT gives: `PREFIX` for
 * membership modes, and `CHANMODES` for which modes take a parameter.
 *
 * @packageDocumentation
 */
import { channelModesOf, defaultPrefix, prefixOf } from "@iirc/protocol/isupport";
import type { ChannelModes, Membership } from "@iirc/protocol/isupport";

import type { Instant } from "./ids.ts";
import type { Fact } from "./known.ts";
import type { ModeChange } from "./news.ts";

/** How this Network's modes read. */
export interface ModeRules {
  /** Membership prefixes, most privileged first. */
  readonly prefix: readonly Membership[];
  readonly channel: ChannelModes;
}

/**
 * The rules from ISUPPORT, with the protocol's defaults for tokens not sent. A `PREFIX`
 * that does not pair its modes and symbols reads as the default.
 * @param isupport - The tokens the Ircd has sent.
 * @returns The rules.
 */
export const rulesOf = (isupport: ReadonlyMap<string, string>): ModeRules => ({
  channel: channelModesOf(isupport.get("CHANMODES")),
  prefix: prefixOf(isupport.get("PREFIX")) ?? defaultPrefix,
});

const takesParameter = (rules: ModeRules, mode: string, set: boolean): boolean =>
  rules.prefix.some((membership) => membership.mode === mode) ||
  rules.channel.list.includes(mode) ||
  rules.channel.always.includes(mode) ||
  (set && rules.channel.whenSet.includes(mode));

/**
 * Reads a mode string and its parameters, such as `+ol-k peer 10 key`. On a Channel,
 * each mode takes a parameter as `PREFIX` and `CHANMODES` say, and a mode they do not
 * name takes none. A User's modes take none. A key's parameter is never kept.
 * @param modes - The mode string.
 * @param args - The parameters after it.
 * @param rules - The Network's rules, or `undefined` for a User's modes.
 * @returns Each change, in order.
 */
export const readModes = (
  modes: string,
  args: readonly string[],
  rules: ModeRules | undefined
): readonly ModeChange[] => {
  const changes: ModeChange[] = [];
  let set = true;
  let next = 0;

  for (const mode of modes) {
    if (mode === "+" || mode === "-") {
      set = mode === "+";
      continue;
    }

    const param = rules !== undefined && takesParameter(rules, mode, set) ? args[next] : undefined;

    if (rules !== undefined && takesParameter(rules, mode, set)) {
      next += 1;
    }

    changes.push({ mode, param: mode === "k" ? undefined : param, set });
  }

  return changes;
};

/**
 * Applies changes to a Channel's modes. List modes, such as bans, and membership modes
 * are not kept here, and a key is kept as set, with `null`.
 * @param modes - The modes as they were.
 * @param changes - The changes.
 * @param rules - The Network's rules.
 * @returns The modes after.
 */
export const applyModes = (
  modes: ReadonlyMap<string, string | null>,
  changes: readonly ModeChange[],
  rules: ModeRules
): ReadonlyMap<string, string | null> => {
  const next = new Map(modes);

  for (const change of changes) {
    const kept =
      !rules.channel.list.includes(change.mode) &&
      !rules.prefix.some((membership) => membership.mode === change.mode);

    if (kept && change.set) {
      next.set(change.mode, change.param ?? null);
    } else if (kept) {
      next.delete(change.mode);
    }
  }

  return next;
};

// A nick cannot start with these, so a listing's leading one is a prefix, even one
// `PREFIX` does not name. Letters, `[]\`^_{|}`, and anything past ASCII can start a nick.
const notNickStart = /^[!-@~]$/u;

/** One member as a `NAMES` listing gives them. */
export interface Listed {
  readonly nick: string;
  readonly prefixes: Fact<ReadonlySet<string>>;
}

/**
 * Whether one name of a `NAMES` listing leads with a symbol `PREFIX` does not name, which
 * stands for a prefix that cannot be named.
 * @param name - The name, with its prefixes.
 * @param rules - The Network's rules.
 * @returns Whether it does.
 */
export const hasUnnamedPrefix = (name: string, rules: ModeRules): boolean => {
  for (const character of name) {
    if (rules.prefix.some((each) => each.symbol === character)) {
      continue;
    }

    return notNickStart.test(character);
  }

  return false;
};

/**
 * Reads one name of a `NAMES` listing, such as `@+peer`. The floor shows only a member's
 * highest prefix, so a member shown with one holds at least that one. A member shown
 * with none holds none, since any would have shown. A symbol `PREFIX` does not name
 * stands for a prefix we cannot name, so what is known is partial.
 * @param name - The name, with its prefixes.
 * @param rules - The Network's rules.
 * @param at - When it was listed.
 * @returns The member, or `undefined` if there is no nick.
 */
export const readListed = (name: string, rules: ModeRules, at: Instant): Listed | undefined => {
  const modes = new Set<string>();
  const characters: string[] = [];

  for (const character of name) {
    characters.push(character);
  }

  let index = 0;
  let unnamed = false;

  for (; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    const membership = rules.prefix.find((each) => each.symbol === character);

    if (membership !== undefined) {
      modes.add(membership.mode);
    } else if (notNickStart.test(character)) {
      unnamed = true;
    } else {
      break;
    }
  }

  const nick = characters.slice(index).join("");

  if (nick === "") {
    return undefined;
  }

  return {
    nick,
    prefixes:
      modes.size === 0 && !unnamed
        ? { _tag: "Known", at, from: "ircd", value: modes }
        : { _tag: "Partial", at, atLeast: modes, from: "ircd" },
  };
};

/**
 * Changes a member's prefixes by one mode change. A set that was partial stays partial.
 * @param prefixes - What was known.
 * @param change - The change.
 * @param at - When.
 * @returns What is known after.
 */
export const changePrefix = (
  prefixes: Fact<ReadonlySet<string>>,
  change: ModeChange,
  at: Instant
): Fact<ReadonlySet<string>> => {
  const apply = (set: ReadonlySet<string>) => {
    const next = new Set(set);

    if (change.set) {
      next.add(change.mode);
    } else {
      next.delete(change.mode);
    }

    return next;
  };

  switch (prefixes._tag) {
    case "Known": {
      return { _tag: "Known", at, from: "ircd", value: apply(prefixes.value) };
    }

    case "Partial": {
      return { _tag: "Partial", at, atLeast: apply(prefixes.atLeast), from: "ircd" };
    }

    case "Stale":
    case "Unknown": {
      return change.set
        ? { _tag: "Partial", at, atLeast: new Set([change.mode]), from: "ircd" }
        : prefixes;
    }

    default: {
      return prefixes satisfies never;
    }
  }
};
