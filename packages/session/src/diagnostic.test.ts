import { Data } from "effect";
import { describe, expect, it } from "vitest";

import { describeDefect } from "./diagnostic.ts";

class Broken extends Data.TaggedError("Broken")<{ readonly message: string }> {}

const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

describe(describeDefect, () => {
  it("HOST-1: gives an error's name and message", () => {
    expect(describeDefect(new TypeError("no such thing"))).toBe("TypeError: no such thing");
  });

  it("HOST-1: gives a tagged error's tag", () => {
    expect(describeDefect(new Broken({ message: "the store broke" }))).toBe(
      "Broken: the store broke"
    );
  });

  it("HOST-1: gives a bare string as it is", () => {
    expect(describeDefect("it broke")).toBe("it broke");
  });

  it("LOG-6: cuts out certificates and keys, whole or cut off", () => {
    expect(describeDefect(new Error(`bad ${pem} here`))).toBe("Error: bad <certificate> here");
    expect(describeDefect(`half -----BEGIN PRIVATE KEY-----\nMIIE`)).toBe("half <certificate>");
  });

  it("HOST-1: keeps to one line, and leaves bounding to the recording (LOG-6)", () => {
    const said = describeDefect(new Error(`one\r\ntwo ${"x".repeat(1000)}`));

    expect(said).toBe(`Error: one  two ${"x".repeat(1000)}`);
  });

  it("HOST-1: says something of anything else", () => {
    expect(describeDefect(42)).toBe("an unknown defect");
    expect(describeDefect(undefined)).toBe("an unknown defect");
  });
});
