import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { admit, fixedPolicy, parseLink, writeAddress } from "./policy.ts";
import type { LinkPolicy } from "./policy.ts";

const publicRecord = "93.184.215.14";

/**
 * What the policy makes of a link: the address it would connect to, or why it is refused.
 * @param link - The link.
 * @param records - What its name resolves to, when it is not a literal.
 * @param policy - The policy.
 * @returns The address, or `refused: <reason>`.
 */
const verdict = (
  link: string,
  records: readonly string[] = [publicRecord],
  policy = fixedPolicy
) => {
  const target = parseLink(policy, link);

  if (Result.isFailure(target)) {
    return `refused: ${target.failure.reason}`;
  }

  const { hostname, literal, port } = target.success;
  const address = admit(policy, port, literal === undefined ? records : [hostname]);

  return Result.isFailure(address)
    ? `refused: ${address.failure.reason}`
    : writeAddress(address.success);
};

const refusedV4 = [
  ["0.0.0.0", "this network"],
  ["0.255.255.255", "this network"],
  ["10.0.0.0", "private"],
  ["10.255.255.255", "private"],
  ["100.64.0.0", "carrier NAT"],
  ["100.127.255.255", "carrier NAT"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["169.254.169.254", "link-local"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["192.0.0.1", "IETF protocol assignments"],
  ["192.0.2.1", "documentation"],
  ["192.31.196.1", "AS112"],
  ["192.52.193.1", "AMT"],
  ["192.88.99.1", "6to4 relay anycast"],
  ["192.168.1.1", "private"],
  ["192.175.48.1", "AS112"],
  ["198.18.0.1", "benchmarking"],
  ["198.19.255.255", "benchmarking"],
  ["198.51.100.1", "documentation"],
  ["203.0.113.1", "documentation"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "reserved"],
] as const;

const refusedV6 = [
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["::ffff:7f00:1", "loopback"],
  ["::ffff:a9fe:a9fe", "link-local"],
  ["::ffff:10.0.0.1", "private"],
  ["::127.0.0.1", "loopback"],
  ["::a00:1", "private"],
  ["64:ff9b::808:808", "NAT64"],
  ["64:ff9b:1::1", "NAT64"],
  ["100::1", "discard-only"],
  ["2001::1", "IETF protocol assignments"],
  ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "IETF protocol assignments"],
  ["2001:2::1", "IETF protocol assignments"],
  ["2001:1ff:ffff::1", "IETF protocol assignments"],
  ["2001:db8::1", "documentation"],
  ["2002:7f00:1::1", "6to4"],
  ["2002:808:808::1", "6to4"],
  ["2620:4f:8000::1", "AS112"],
  ["3fff::1", "documentation"],
  ["3fff:fff::1", "documentation"],
  ["5f00::1", "segment routing"],
  ["fc00::1", "unique local"],
  ["fdff:ffff::1", "unique local"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local"],
  ["fec0::1", "site-local"],
  ["ff02::1", "multicast"],
  ["1::1", "not global unicast"],
  ["4000::1", "not global unicast"],
] as const;

const admittedV4 = [
  "1.1.1.1",
  "8.8.8.8",
  "11.0.0.1",
  "100.63.255.255",
  "100.128.0.0",
  "126.255.255.255",
  "128.0.0.1",
  "172.15.255.255",
  "172.32.0.0",
  "198.17.255.255",
  "198.20.0.0",
  "223.255.255.255",
];

const admittedV6 = [
  ["2606:4700:4700::1111", "[2606:4700:4700::1111]"],
  ["2a00:1450:4001::1", "[2a00:1450:4001::1]"],
  ["2001:200::1", "[2001:200::1]"],
  ["3fff:1000::1", "[3fff:1000::1]"],
  ["::ffff:8.8.8.8", "8.8.8.8"],
] as const;

describe("every special IPv4 range is refused", () => {
  it.each(refusedV4)("%s, %s", (address, name) => {
    expect(verdict(`http://${address}/`)).toBe(`refused: ${address} is ${name}`);
  });
});

describe("every special IPv6 range is refused", () => {
  it.each(refusedV6)("[%s], %s", (address, name) => {
    expect(verdict(`http://[${address}]/`)).toMatch(new RegExp(`^refused: .* is ${name}$`, "u"));
  });
});

describe("public addresses are admitted", () => {
  it.each(admittedV4)("%s", (address) => {
    expect(verdict(`https://${address}/`)).toBe(address);
  });

  it.each(admittedV6)("[%s]", (address, connected) => {
    expect(verdict(`https://[${address}]/`)).toBe(connected);
  });
});

describe("spellings the parser folds into loopback are refused", () => {
  it.each([
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://①②⑦.0.0.1/",
    "http://１２７.0.0.1/",
    "http://127.0.0.1./",
    "http://127.0.0.1%2e/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[::127.0.0.1]/",
  ])("%s", (link) => {
    expect(verdict(link)).toMatch(/is loopback$/u);
  });

  it("the zero host is this network", () => {
    expect(verdict("http://0/")).toBe("refused: 0.0.0.0 is this network");
  });

  it("an IPv6 zone is not a link", () => {
    expect(verdict("http://[::1%25eth0]/")).toBe("refused: not a link");
  });
});

describe("only http and https are fetched", () => {
  it.each([["file:///etc/passwd", "file:"]])("%s", (link, scheme) => {
    expect(verdict(link)).toBe(`refused: scheme ${scheme}`);
  });

  it("text that is not a link is refused", () => {
    expect(verdict("not a link")).toBe("refused: not a link");
  });
});

describe("only ports 80 and 443 are fetched", () => {
  it.each([["http://example.com:22/", 22]])("%s", (link, port) => {
    expect(verdict(link)).toBe(`refused: port ${port}`);
  });

  it.each([
    "http://example.com/",
    "https://example.com/",
    "http://example.com:443/",
    "https://example.com:80/",
  ])("%s", (link) => {
    expect(verdict(link)).toBe(publicRecord);
  });
});

describe("userinfo is refused", () => {
  it.each(["http://user@example.com/", "http://:pass@example.com/"])("%s", (link) => {
    expect(verdict(link)).toBe("refused: userinfo");
  });
});

describe("every record a name resolves to is checked", () => {
  it("one public and one private record is refused", () => {
    expect(verdict("https://mixed.test/", ["8.8.8.8", "10.0.0.1"])).toBe(
      "refused: 10.0.0.1 is private"
    );
  });

  it("a private IPv6 record among public ones is refused", () => {
    expect(verdict("https://mixed.test/", ["8.8.8.8", "2606:4700::1", "fd00::1"])).toBe(
      "refused: fd00::1 is unique local"
    );
  });

  it("an IPv4-mapped record is unmapped before it is checked", () => {
    expect(verdict("https://mapped.test/", ["::ffff:127.0.0.1"])).toBe(
      "refused: ::ffff:127.0.0.1 is loopback"
    );
  });

  it("a name that resolves to nothing is refused", () => {
    expect(verdict("https://empty.test/", [])).toBe("refused: no address");
  });

  it("a record that is not an address is refused", () => {
    expect(verdict("https://odd.test/", ["8.8.8.8", "010.0.0.1"])).toBe(
      "refused: not an address: 010.0.0.1"
    );
  });

  it("IPv4 is chosen before IPv6 when both are public", () => {
    expect(verdict("https://both.test/", ["2606:4700::1", "1.1.1.1"])).toBe("1.1.1.1");
  });

  it("a name with a trailing dot is resolved like any name", () => {
    expect(verdict("https://example.com./")).toBe(publicRecord);
  });
});

const parsed = (link: string, base?: string) =>
  Result.getOrUndefined(parseLink(fixedPolicy, link, base));

describe("a link is parsed first", () => {
  it("a redirect is resolved against the link that redirected, by name", () => {
    expect(parsed("/next?q=1#top", "https://example.com/a/b")).toMatchObject({
      host: "example.com",
      href: "https://example.com/next?q=1",
      path: "/next?q=1",
      port: 443,
    });
  });

  it("the Host header keeps a port that is not the default", () => {
    const policy: LinkPolicy = { admitted: [], ports: [80, 443, 8443] };
    expect(Result.getOrUndefined(parseLink(policy, "https://Example.COM:8443/"))).toMatchObject({
      host: "example.com:8443",
      hostname: "example.com",
    });
  });
});
