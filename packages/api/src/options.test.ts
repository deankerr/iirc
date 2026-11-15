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

const takesUrl = Schema.is(HttpUrl);

const takesListen = Schema.is(ListenAddress);

describe("the options under store and uploads", () => {
  it("are named in full, and only uploads.maxSize starts as anything, at 100 MiB", () => {
    expect({ defaults: ownerDefaults, names: ownerOptionNames }).toStrictEqual({
      defaults: { "uploads.maxSize": 104_857_600 },
      names: [
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

  it("takes an http or https URL with nothing after its path, in the form the URL writes", () => {
    expect(
      [
        "https://files.example.com",
        "http://127.0.0.1:9000/bucket/links",
        "https://files.example.com/",
        "ftp://files.example.com",
        "https://files.example.com?x=1",
        "https://files.example.com#top",
        "https://user:pass@files.example.com",
        "HTTPS://Files.Example.com",
        "files.example.com",
      ].map((each) => takesUrl(each))
    ).toStrictEqual([true, true, false, false, false, false, false, false, false]);
  });

  it("takes a listener's address as host:port, with an IPv6 host in brackets", () => {
    expect(
      [
        "127.0.0.1:7668",
        "localhost:80",
        "[::1]:7668",
        "files.example.com:65535",
        "127.0.0.1",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        "::1:7668",
        "127.0.0.1:07668",
      ].map((each) => takesListen(each))
    ).toStrictEqual([true, true, true, true, false, false, false, false, false]);
  });
});
