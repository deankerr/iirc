import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  HttpUrl,
  ListenAddress,
  OwnerOptions,
  credentialsNamed,
  ownerCredentialOptions,
  ownerDefaults,
  ownerOptionNames,
  ownerValueKept,
} from "./options.ts";

const all = <T>(length: number, value: T): T[] => Array.from({ length }, () => value);

const readUrl = Schema.decodeUnknownOption(HttpUrl);

const readsUrl = (text: string): string | undefined => {
  const read = readUrl(text);

  return read._tag === "Some" ? read.value : undefined;
};

const takesListen = Schema.is(ListenAddress);

describe("the options under store, uploads, and previews", () => {
  it("are named in full, and only uploads.maxSize and previews.maxTotal start as anything, at 100 MiB and 1 GiB", () => {
    expect({ defaults: ownerDefaults, names: ownerOptionNames }).toStrictEqual({
      defaults: { "previews.maxTotal": 1_073_741_824, "uploads.maxSize": 104_857_600 },
      names: [
        "away.after",
        "away.message",
        "previews.maxTotal",
        "store.s3.accessKeyId",
        "store.s3.bucket",
        "store.s3.endpoint",
        "store.s3.region",
        "store.s3.secretAccessKey",
        "uploads.expireAfter",
        "uploads.listen",
        "uploads.maxSize",
        "uploads.maxTotal",
        "uploads.publicUrl",
      ],
    });
  });

  it("finds the bucket's keys as Credential options by their Schema, and the Credentials they name", () => {
    expect({
      named: credentialsNamed(
        Schema.decodeSync(OwnerOptions)({
          "previews.maxTotal": 1,
          "store.s3.bucket": "uploads",
          "store.s3.secretAccessKey": "bucket-secret",
          "uploads.maxSize": 1,
        })
      ),
      options: ownerCredentialOptions,
    }).toStrictEqual({
      named: new Set(["bucket-secret"]),
      options: ["store.s3.accessKeyId", "store.s3.secretAccessKey"],
    });
  });

  it("takes a size in whole bytes, and days to keep an Upload in whole days", () => {
    expect([
      ownerValueKept("uploads.maxSize", 1),
      ownerValueKept("uploads.maxSize", 0),
      ownerValueKept("uploads.maxSize", 1.5),
      ownerValueKept("uploads.maxSize", "1024"),
      ownerValueKept("uploads.maxTotal", 2 ** 53),
      ownerValueKept("uploads.expireAfter", 30),
      ownerValueKept("uploads.expireAfter", 36_501),
    ]).toStrictEqual([1, undefined, undefined, undefined, undefined, 30, undefined]);
  });

  it("reads any spelling of an http or https URL as the one form the URL writes, with its path", () => {
    expect(
      [
        "https://files.example.com",
        "https://files.example.com/",
        "HTTPS://Files.Example.com",
        "https://files.example.com:443",
        "https://files.example.com:443/",
        "https://s3.us-east-1.amazonaws.com/",
        "http://localhost:9000/",
        "http://localhost:80/",
        "https://files.example.com/uploads/",
        "https://files.example.com/uploads",
        "http://127.0.0.1:9000/bucket/links/",
        "https://files.example.com/a/./b/../c",
      ].map((each) => readsUrl(each))
    ).toStrictEqual([
      "https://files.example.com",
      "https://files.example.com",
      "https://files.example.com",
      "https://files.example.com",
      "https://files.example.com",
      "https://s3.us-east-1.amazonaws.com",
      "http://localhost:9000",
      "http://localhost",
      "https://files.example.com/uploads",
      "https://files.example.com/uploads",
      "http://127.0.0.1:9000/bucket/links",
      "https://files.example.com/a/c",
    ]);
  });

  it("writes a URL it read as it was read, so what is journaled is what the Schema reads again", () => {
    const written = ["https://x.example:443", "https://files.example.com/uploads/"].map((each) =>
      Schema.encodeSync(HttpUrl)(Schema.decodeSync(HttpUrl)(each))
    );

    expect([written, written.map((each) => readsUrl(each))]).toStrictEqual([
      ["https://x.example", "https://files.example.com/uploads"],
      ["https://x.example", "https://files.example.com/uploads"],
    ]);
  });

  it("refuses a URL of another scheme, with a user, a query, or a fragment, or not absolute", () => {
    expect(
      [
        "ftp://files.example.com",
        "https://files.example.com?x=1",
        "https://files.example.com/?",
        "https://files.example.com#top",
        "https://user:pass@files.example.com",
        "https://user@files.example.com",
        "files.example.com",
        "/uploads",
        "https://",
        "https://files.example.com /x",
        "",
      ].map((each) => readsUrl(each))
    ).toStrictEqual(all(11, undefined));
  });

  it("takes a listener's address as host:port, with an IPv6 host in brackets", () => {
    expect(
      [
        "127.0.0.1:7668",
        "localhost:80",
        "localhost.:7668",
        "[::1]:7668",
        "[2001:db8::1]:443",
        "[::ffff:1.2.3.4]:80",
        "0.0.0.0:80",
        "uploads.example.com:443",
        "files.example.com:65535",
        "a-b.example:1",
      ].map((each) => takesListen(each))
    ).toStrictEqual(all(10, true));
  });

  it("refuses a listener's address with no port, a port out of range, or a host that is none", () => {
    expect(
      [
        "127.0.0.1",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        "127.0.0.1:07668",
        "::1:7668",
        "[.]:7668",
        "[::::]:7668",
        "[1:2:3]:7668",
        "[::1:7668",
        "[]:7668",
        "256.0.0.1:80",
        "1.2.3:80",
        "1.2.3.4.5:80",
        "01.2.3.4:80",
        "-a.example:80",
        "a-.example:80",
        "a..example:80",
        "a.example..:80",
        ".example:80",
        "a_b.example:80",
        `${"a".repeat(64)}.example:80`,
        ":80",
        "",
      ].map((each) => takesListen(each))
    ).toStrictEqual(all(23, false));
  });
});
