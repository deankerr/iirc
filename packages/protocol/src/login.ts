import { stripFormatting } from "./format.ts";
import { isChannelName } from "./join.ts";

/** What a Line says about a login to services, in the service's own words (CONN-6). */
export type LoginSign =
  | { readonly _tag: "LoggedIn"; readonly text: string }
  | { readonly _tag: "LoginFailed"; readonly text: string };

/** The parts of a Line that {@link loginSign} reads. */
export interface SignLine {
  readonly command: string;
  readonly params: readonly string[];
  readonly source?: string | undefined;
}

// Wording is a hint, as LIVE-5's is: services differ, and none of this is a protocol.
// Atheme says `You are now identified for x.`, Anope `Password accepted - you are now
// recognized.`, and Ergo `You're now logged in as x`. On failure, Atheme says `Invalid
// password for x.` and `x is not registered.`, Anope `Password incorrect.` and `Nick x
// isn't registered.`
const loggedInText =
  /\byou are now identified\b|\bpassword accepted\b|\byou(?: are|'re) now logged in\b/iu;

const failedText = /\binvalid password\b|\bpassword incorrect\b|\bis(?:n't| not) registered\b/iu;

const asciiLower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

const nickOf = (source: string | undefined) => source?.split(/[!@]/u, 1)[0];

// Only Self's own modes reach us in a `MODE` whose Target is no Channel.
const addsRegistered = (letters: string) => {
  let adding = true;

  for (const letter of letters) {
    if (letter === "+" || letter === "-") {
      adding = letter === "+";
    } else if (letter === "r" && adding) {
      return true;
    }
  }

  return false;
};

const fromService = (line: SignLine, services: readonly string[]) => {
  const nick = nickOf(line.source);

  return nick !== undefined && services.some((service) => asciiLower(service) === asciiLower(nick));
};

const noticeSign = (text: string): LoginSign | undefined => {
  const plain = stripFormatting(text);

  if (failedText.test(plain)) {
    return { _tag: "LoginFailed", text };
  }

  return loggedInText.test(plain) ? { _tag: "LoggedIn", text } : undefined;
};

/**
 * Whether an inbound Line is a sign that a login to services worked or failed (CONN-6):
 * `900` or `+r` on Self for success, `904` for failure, or a `NOTICE` from a service
 * whose words say either.
 * @param line - The inbound Line.
 * @param services - The nicks that are services, compared without regard to ASCII case.
 * @returns The sign with the Line's own words, or nothing if it is no sign.
 */
export const loginSign = (line: SignLine, services: readonly string[]): LoginSign | undefined => {
  const { command, params } = line;
  const text = params.at(-1) ?? "";

  switch (command) {
    case "900": {
      return { _tag: "LoggedIn", text };
    }

    case "904": {
      return { _tag: "LoginFailed", text };
    }

    case "MODE": {
      const [target = "", letters = ""] = params;

      return !isChannelName(target) && addsRegistered(letters)
        ? { _tag: "LoggedIn", text: `${target} ${letters}` }
        : undefined;
    }

    case "NOTICE": {
      return fromService(line, services) ? noticeSign(text) : undefined;
    }

    default: {
      return undefined;
    }
  }
};
