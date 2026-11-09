/**
 * Strict Transport Security, in the core: an Ircd's policy that the Client connect to its
 * host only over TLS. It is not a Feature, because the policy outlives Connections and
 * decides where to dial before any cap is negotiated. The `sts` cap is never requested:
 * its value is read where `CAP LS` and `CAP NEW` offer it.
 *
 * @packageDocumentation
 */
import type { StsPolicy } from "./client.ts";
import type { IrcdAddress } from "./configuration.ts";
import type { CapName } from "./ids.ts";
import { Instant } from "./ids.ts";
import type { Run } from "./run.ts";
import { hangup, linkOf } from "./run.ts";
import type { Link, State } from "./state.ts";

/**
 * Until when a policy holds: `at` plus `duration` seconds, exactly, while that fits in a
 * safe integer of milliseconds, and beyond it the largest that does, so a policy never
 * ends sooner than it says.
 * @param at - When it was learnt, or its Connection ended.
 * @param duration - Seconds.
 * @returns Its expiry.
 */
const untilAfter = (at: Instant, duration: number): Instant =>
  Instant.make(Math.min(at + duration * 1000, Number.MAX_SAFE_INTEGER));

/** The parts of an `sts` value the Client reads. A part missing or malformed is `undefined`. */
interface StsValue {
  readonly port: number | undefined;
  readonly duration: number | undefined;
}

const digits = /^[0-9]+$/u;

/**
 * Reads an `sts` value: `<key>[=<value>]` tokens, separated by commas. Keys the Client
 * does not know are ignored. A key given more than once, which the spec forbids, is
 * taken as not given, since nothing says which to believe.
 * @param value - The cap's value.
 * @returns Its `port` and `duration`, where each is valid.
 */
const parseValue = (value: string): StsValue => {
  const seen = new Map<string, string | undefined>();
  const repeated = new Set<string>();

  for (const token of value.split(",")) {
    const at = token.indexOf("=");
    const key = at === -1 ? token : token.slice(0, at);

    if (seen.has(key)) {
      repeated.add(key);
    } else {
      seen.set(key, at === -1 ? undefined : token.slice(at + 1));
    }
  }

  const integer = (key: string): number | undefined => {
    const text = repeated.has(key) ? undefined : seen.get(key);

    return text !== undefined && digits.test(text) ? Number(text) : undefined;
  };

  const port = integer("port");
  const duration = integer("duration");

  return {
    duration: duration === undefined ? undefined : Math.min(duration, Number.MAX_SAFE_INTEGER),
    port: port !== undefined && port >= 1 && port <= 65_535 ? port : undefined,
  };
};

/**
 * A host as policies are keyed: a DNS name, folded to lower case in ASCII, with one
 * trailing dot left off.
 * @param host - The host, as configured.
 * @returns Its key.
 */
const hostKey = (host: string): string => {
  const lower = host.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
};

// An IPv6 literal holds a colon, and an IPv4 one only digits and dots, which no DNS name
// does, since its last label cannot be all digits.
const isIpLiteral = (key: string): boolean => key.includes(":") || /^[0-9.]+$/u.test(key);

/**
 * The policy that holds for a host now, if any.
 * @param state - The State.
 * @param host - The host, as configured.
 * @param at - Now.
 * @returns The policy, while `at` is before its expiry.
 */
const holding = (state: State, host: string, at: Instant): StsPolicy | undefined => {
  const policy = state.policies.get(hostKey(host));

  return policy !== undefined && at < policy.until ? policy : undefined;
};

/**
 * Where to dial an Ircd: while a policy holds for its host, TLS on the policy's port,
 * whatever Configuration says. Otherwise, the address as configured.
 * @param state - The State.
 * @param ircd - The Ircd, as configured.
 * @param at - Now.
 * @returns The address to dial.
 */
export const addressFor = (state: State, ircd: IrcdAddress, at: Instant): IrcdAddress => {
  const policy = holding(state, ircd.host, at);

  return policy === undefined ? ircd : { host: ircd.host, port: policy.port, tls: true };
};

// Sets or removes one host's policy. No policy that holds is ever dropped to make room:
// only the hosts of Connections the Client dialled, from the Owner's \`ircds\`, have one.
const withPolicy = (state: State, key: string, policy: StsPolicy | undefined): State => {
  const policies = new Map(state.policies);

  policies.delete(key);

  if (policy !== undefined) {
    policies.set(key, policy);
  }

  return { ...state, policies };
};

/**
 * Reads the `sts` cap where `CAP LS` or `CAP NEW` offers it. Over TLS, a valid
 * `duration` sets the policy for the Connection's host, on the Connection's port, and
 * `duration=0` removes it: a `port` is ignored. Over plaintext, a valid `port` ends the
 * Connection with `Upgrading`, and nothing more is sent: a `duration` is ignored. A
 * value with a required part missing or malformed changes nothing.
 * @param run - The step.
 * @param list - The caps offered, with their values.
 * @returns Whether the Connection is now ending to upgrade.
 */
export const readSts = (run: Run, list: readonly (readonly [CapName, string])[]): boolean => {
  const link = linkOf(run);
  const entry = list.find(([name]) => name === "sts");

  if (link === undefined || entry === undefined) {
    return false;
  }

  const value = parseValue(entry[1]);

  if (!link.ircd.tls) {
    if (value.port === undefined || link.closing !== undefined) {
      return false;
    }

    hangup(run, { _tag: "Upgrading", port: value.port });

    return true;
  }

  const key = hostKey(link.ircd.host);

  // A policy is for a hostname, and an IP literal is not one: TLS sends it no name.
  if (value.duration === undefined || isIpLiteral(key)) {
    return false;
  }

  run.state = withPolicy(
    run.state,
    key,
    value.duration === 0
      ? undefined
      : {
          duration: value.duration,
          port: link.ircd.port,
          until: untilAfter(run.at, value.duration),
        }
  );

  return false;
};

// Whether a Connection is one its host's policy covers: over TLS, dialled while the
// policy held, or with the policy learnt on it, which also makes its expiry later.
const covers = (link: Link, policy: StsPolicy): boolean =>
  link.ircd.tls && policy.until > link.dialled;

/**
 * A Connection ended: the expiry of its host's policy moves to now plus the `duration`
 * last advertised, as the spec's rescheduling says. Only a Connection that opened counts:
 * one that never did heard nothing from the Ircd.
 * @param state - The State.
 * @param link - The Connection that ended.
 * @param at - When.
 * @returns The State after.
 */
export const rescheduled = (state: State, link: Link, at: Instant): State => {
  const key = hostKey(link.ircd.host);
  const policy = state.policies.get(key);

  if (policy === undefined || link.phase._tag !== "Open" || !covers(link, policy)) {
    return state;
  }

  return withPolicy(state, key, { ...policy, until: untilAfter(at, policy.duration) });
};

/**
 * Forgets the policies that have expired, but for one the Connection in progress
 * covers, whose expiry moves when it ends.
 * @param state - The State.
 * @param at - Now.
 * @returns The State after.
 */
export const pruned = (state: State, at: Instant): State => {
  const link = state.network._tag === "Connection" ? state.network.link : undefined;

  const kept = (key: string, policy: StsPolicy): boolean =>
    at < policy.until ||
    (link !== undefined && hostKey(link.ircd.host) === key && covers(link, policy));

  const expired = [...state.policies].filter(([key, policy]) => !kept(key, policy));

  if (expired.length === 0) {
    return state;
  }

  return {
    ...state,
    policies: new Map([...state.policies].filter(([key, policy]) => kept(key, policy))),
  };
};
