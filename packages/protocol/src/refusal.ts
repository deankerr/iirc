const refusalNumerics: ReadonlySet<string> = new Set(["463", "464", "465"]);

// Wording seen to mean that the Connection gave out, or that the Network is full or
// restarting, which a later try can get past (LIVE-5). Anything else must count as a
// refusal. Ergo says `Ping timeout: 2m0s` and `Registration timeout: 1m0s`, and turns
// connections away with its throttle, `Too many clients from your network`, and, under
// DEFCON, `New connections to this server are temporarily restricted`. ngircd says
// `Server going down`, `Connection limit reached`, and `Connection refused, too many
// connections from your IP address`.
const transientText = new RegExp(
  [
    String.raw`\b(?:ping|registration|connection)\s+time(?:d\s+)?out\b`,
    String.raw`\bserver going down\b`,
    String.raw`\bconnection limit reached\b`,
    String.raw`\btoo many connections from your ip\b`,
    String.raw`\battempted to connect too many times\b`,
    String.raw`\btoo many clients from\b`,
    String.raw`\btemporarily restricted\b`,
  ].join("|"),
  "iu"
);

// A ban says so, and its reason is free text that may sound like any of the above.
const banText = /\bbanned\b/iu;

// A `FAIL` names the command that failed. Ergo answers a reserved nick with `433` and
// then `FAIL NICK NICKNAME_RESERVED`, so this one is CONN-4's to handle.
const isNickFailure = (command: string, params: readonly string[]) =>
  command === "FAIL" && params[0] === "NICK";

/**
 * Whether a Line received while registering means the Network does not want us
 * (LIVE-5). Numerics always do. For `ERROR` and `FAIL`, wording can only show that the
 * failure was transient, so anything unrecognised is a refusal. Only meaningful before
 * `001`, so only the machine calls this, and only while registering.
 * @param command - The Line's command.
 * @param params - The Line's parameters.
 * @returns Whether to back off as for a refusal.
 */
export const isRefusal = (command: string, params: readonly string[]): boolean => {
  if (refusalNumerics.has(command)) {
    return true;
  }

  if ((command !== "ERROR" && command !== "FAIL") || isNickFailure(command, params)) {
    return false;
  }

  const text = params.at(-1) ?? "";

  return banText.test(text) || !transientText.test(text);
};
