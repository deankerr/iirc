/**
 * The address policy, as a value: which links may be fetched, and which addresses they may
 * reach. Pure, so every rule is a vector in a table.
 *
 * @packageDocumentation
 */
import { Result } from "effect";

import { LinkRefused } from "./link-fetch.ts";

/** A special address the policy admits anyway, on one port only. Tests use one. */
export interface Admitted {
  readonly address: string;
  readonly port: number;
}

/** What may be fetched. */
export interface LinkPolicy {
  /** The ports a link may name, to any public address. */
  readonly ports: readonly number[];
  /** Special addresses admitted anyway, each on its own port. */
  readonly admitted: readonly Admitted[];
}

/** The policy production uses: `http` and `https` on 80 and 443, to public addresses only. */
export const fixedPolicy: LinkPolicy = { admitted: [], ports: [80, 443] };

/** An IP address, as its 4 or 16 bytes. */
export interface Address {
  readonly family: 4 | 6;
  readonly bytes: readonly number[];
}

/** A link the policy let through as far as its address, ready to resolve and check. */
export interface Target {
  /** The link, by name, as the parser normalised it, without its fragment. */
  readonly href: string;
  readonly scheme: "http:" | "https:";
  /** The name, or the IP literal without brackets. */
  readonly hostname: string;
  /** The host as a `Host` header names it, with the port only when it is not the default. */
  readonly host: string;
  readonly port: number;
  /** The path and query. */
  readonly path: string;
  /** The address the link names itself, when it is an IP literal, so nothing is resolved. */
  readonly literal: Address | undefined;
}

const defaultPorts = { "http:": 80, "https:": 443 } as const;

const refuse = (reason: string) => Result.fail(new LinkRefused({ reason }));

const decimalOctet = /^(?:0|[1-9]\d{0,2})$/u;

/**
 * Reads dotted-decimal IPv4, as the URL parser writes it and a resolver answers it. Any other
 * spelling, such as octal or a leading zero, is not read.
 * @param text - The address.
 * @returns Its four bytes, or nothing.
 */
const readIPv4 = (text: string): number[] | undefined => {
  const parts = text.split(".");

  if (parts.length !== 4 || !parts.every((part) => decimalOctet.test(part))) {
    return undefined;
  }

  const bytes = parts.map(Number);

  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
};

const hexGroup = /^[0-9a-f]{1,4}$/iu;

const groupsOf = (part: string, last: boolean): number[] | undefined => {
  if (part === "") {
    return [];
  }

  const pieces = part.split(":");
  const groups: number[] = [];

  for (const [index, piece] of pieces.entries()) {
    if (piece.includes(".")) {
      const v4 = last && index === pieces.length - 1 ? readIPv4(piece) : undefined;

      if (v4 === undefined) {
        return undefined;
      }

      const [a = 0, b = 0, c = 0, d = 0] = v4;

      groups.push(a * 256 + b, c * 256 + d);
    } else if (hexGroup.test(piece)) {
      groups.push(Number.parseInt(piece, 16));
    } else {
      return undefined;
    }
  }

  return groups;
};

/**
 * Reads IPv6 without brackets, in any form a parser or resolver writes, with an IPv4 tail or
 * without. A zone, such as `%eth0`, is not read.
 * @param text - The address.
 * @returns Its sixteen bytes, or nothing.
 */
const readIPv6 = (text: string): number[] | undefined => {
  const halves = text.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const head = groupsOf(halves[0] ?? "", halves.length === 1);
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "", true) : [];

  if (head === undefined || tail === undefined) {
    return undefined;
  }

  const missing = 8 - head.length - tail.length;

  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }

  const groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail];

  return groups.flatMap((group) => [Math.floor(group / 256), group % 256]);
};

/**
 * Reads an IP address, IPv4 dotted-decimal or IPv6 with or without brackets.
 * @param text - The address.
 * @returns The address, or nothing when it is not one.
 */
export const readAddress = (text: string): Address | undefined => {
  const v4 = readIPv4(text);

  if (v4 !== undefined) {
    return { bytes: v4, family: 4 };
  }

  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const v6 = bare.includes(":") ? readIPv6(bare) : undefined;

  return v6 === undefined ? undefined : { bytes: v6, family: 6 };
};

/**
 * Writes an address as a URL's host names it: IPv6 in brackets.
 * @param address - The address.
 * @returns Its text.
 */
export const writeAddress = (address: Address): string => {
  if (address.family === 4) {
    return address.bytes.join(".");
  }

  const groups = Array.from({ length: 8 }, (_, index) =>
    ((address.bytes[index * 2] ?? 0) * 256 + (address.bytes[index * 2 + 1] ?? 0)).toString(16)
  );

  return `[${groups.join(":")}]`;
};

/**
 * An address as a string of its bits, so a prefix of it is a prefix of the string.
 * @param address - The address.
 * @returns Its bits, as `0` and `1`.
 */
const bitsOf = (address: Address) =>
  address.bytes.map((byte) => byte.toString(2).padStart(8, "0")).join("");

interface Range {
  readonly family: 4 | 6;
  /** The bits every address in the range starts with. */
  readonly prefix: string;
  readonly name: string;
}

const range = (cidr: string, name: string): Range => {
  const [first = "", length = ""] = cidr.split("/");
  const address = readAddress(first);

  if (address === undefined) {
    throw new Error(`not a range: ${cidr}`);
  }

  return { family: address.family, name, prefix: bitsOf(address).slice(0, Number(length)) };
};

const within = (address: Address, of: Range) =>
  address.family === of.family && bitsOf(address).startsWith(of.prefix);

// The IANA special-purpose registries (RFC 6890) and research #22. Where the registry calls a
// block globally reachable but it is still not a place a stranger's link should lead, such as
// AS112 and AMT, it is refused: that is the stricter side of a policy choice.
const ipv4Ranges: readonly Range[] = [
  range("0.0.0.0/8", "this network"),
  range("10.0.0.0/8", "private"),
  range("100.64.0.0/10", "carrier NAT"),
  range("127.0.0.0/8", "loopback"),
  range("169.254.0.0/16", "link-local"),
  range("172.16.0.0/12", "private"),
  range("192.0.0.0/24", "IETF protocol assignments"),
  range("192.0.2.0/24", "documentation"),
  range("192.31.196.0/24", "AS112"),
  range("192.52.193.0/24", "AMT"),
  range("192.88.99.0/24", "6to4 relay anycast"),
  range("192.168.0.0/16", "private"),
  range("192.175.48.0/24", "AS112"),
  range("198.18.0.0/15", "benchmarking"),
  range("198.51.100.0/24", "documentation"),
  range("203.0.113.0/24", "documentation"),
  range("224.0.0.0/4", "multicast"),
  // Includes the limited broadcast address, 255.255.255.255.
  range("240.0.0.0/4", "reserved"),
];

const ipv4Mapped = range("::ffff:0:0/96", "IPv4-mapped");
const ipv4Compatible = range("::/96", "IPv4-compatible");

// Checked before anything is unmapped, so the unspecified and loopback addresses keep their
// own names. Every other IPv6 address must also be global unicast, `2000::/3`, so a block
// IANA has not yet assigned is refused rather than missed.
const ipv6Ranges: readonly Range[] = [
  range("::/128", "unspecified"),
  range("::1/128", "loopback"),
  range("64:ff9b::/96", "NAT64"),
  range("64:ff9b:1::/48", "NAT64"),
  range("100::/64", "discard-only"),
  // Includes Teredo, `2001::/32`, and benchmarking, `2001:2::/48`.
  range("2001::/23", "IETF protocol assignments"),
  range("2001:db8::/32", "documentation"),
  range("2002::/16", "6to4"),
  range("2620:4f:8000::/48", "AS112"),
  range("3fff::/20", "documentation"),
  range("5f00::/16", "segment routing"),
  range("fc00::/7", "unique local"),
  range("fe80::/10", "link-local"),
  range("fec0::/10", "site-local"),
  range("ff00::/8", "multicast"),
];

const globalUnicast = range("2000::/3", "global unicast");

/**
 * The IPv4 address an IPv4-mapped or IPv4-compatible IPv6 address carries, which is where it
 * leads, or the address itself.
 * @param address - The address.
 * @returns The address to check and connect to.
 */
const unmapped = (address: Address): Address =>
  address.family === 6 && (within(address, ipv4Mapped) || within(address, ipv4Compatible))
    ? { bytes: address.bytes.slice(12), family: 4 }
    : address;

/**
 * Why an address is special, or nothing when it is public.
 * @param address - The address, as resolved or written.
 * @returns The name of its range.
 */
const special = (address: Address): string | undefined => {
  const named = ipv6Ranges.find((each) => within(address, each));

  if (named !== undefined) {
    return named.name;
  }

  const target = unmapped(address);

  if (target.family === 4) {
    return ipv4Ranges.find((each) => within(target, each))?.name;
  }

  return within(target, globalUnicast) ? undefined : "not global unicast";
};

const same = (one: Address, other: Address) =>
  one.family === other.family && one.bytes.every((byte, index) => byte === other.bytes[index]);

const isAdmitted = (policy: LinkPolicy, address: Address, port: number) =>
  policy.admitted.some((each) => {
    const admitted = readAddress(each.address);

    return each.port === port && admitted !== undefined && same(unmapped(admitted), address);
  });

/**
 * Parses a link with the WHATWG URL parser and checks what it produced: the scheme, the
 * userinfo, and the port. Its address is checked by {@link admit}, once known.
 * @param policy - What may be fetched.
 * @param link - The link, or a redirect's `Location`.
 * @param base - What a relative link is resolved against: the link that redirected, by name.
 * @returns The target, or why it is refused.
 */
export const parseLink = (
  policy: LinkPolicy,
  link: string,
  base?: string
): Result.Result<Target, LinkRefused> => {
  const url = URL.parse(link, base);

  if (url === null) {
    return refuse("not a link");
  }

  const scheme = url.protocol;

  if (scheme !== "http:" && scheme !== "https:") {
    return refuse(`scheme ${scheme}`);
  }

  if (url.username !== "" || url.password !== "") {
    return refuse("userinfo");
  }

  const port = url.port === "" ? defaultPorts[scheme] : Number(url.port);

  if (!policy.ports.includes(port) && !policy.admitted.some((each) => each.port === port)) {
    return refuse(`port ${port}`);
  }

  url.hash = "";
  const literal = readAddress(url.hostname);

  return Result.succeed({
    host: url.host,
    hostname: literal?.family === 6 ? url.hostname.slice(1, -1) : url.hostname,
    href: url.href,
    literal,
    path: `${url.pathname}${url.search}`,
    port,
    scheme,
  });
};

/**
 * Checks every address a link's host resolved to, and refuses them all if any is special,
 * so a name can never smuggle one private address among public ones. IPv4-mapped and
 * IPv4-compatible IPv6 is unmapped first. An empty answer is refused too, though an adapter
 * answers that as unreachable before it asks.
 * @param policy - What may be fetched.
 * @param port - The port the link names.
 * @param addresses - Every A and AAAA record, or the link's own literal.
 * @returns The address to connect to, IPv4 first, or why the name is refused.
 */
export const admit = (
  policy: LinkPolicy,
  port: number,
  addresses: readonly string[]
): Result.Result<Address, LinkRefused> => {
  const checked: Address[] = [];

  for (const text of addresses) {
    const address = readAddress(text);

    if (address === undefined) {
      return refuse(`not an address: ${text}`);
    }

    const target = unmapped(address);

    if (!isAdmitted(policy, target, port)) {
      const why = special(address);

      if (why !== undefined) {
        return refuse(`${text} is ${why}`);
      }

      if (!policy.ports.includes(port)) {
        return refuse(`port ${port}`);
      }
    }

    checked.push(target);
  }

  const chosen = checked.find((each) => each.family === 4) ?? checked[0];

  return chosen === undefined ? refuse("no address") : Result.succeed(chosen);
};
