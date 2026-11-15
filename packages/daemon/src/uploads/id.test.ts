import { describe, expect, it } from "vitest";

import { encodeUploadId, idBytes, idLength, isUploadId } from "./id.ts";

describe(encodeUploadId, () => {
  it("encodes all-zero bytes as zeros", () => {
    expect(encodeUploadId(new Uint8Array(idBytes))).toBe("0000000000000000");
  });

  it("encodes all-ones bytes as the last letter", () => {
    expect(encodeUploadId(new Uint8Array(idBytes).fill(0xff))).toBe("zzzzzzzzzzzzzzzz");
  });

  it("encodes a mixed vector big-endian", () => {
    expect(encodeUploadId(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(
      "041061050r3gg28a"
    );
  });

  it("is idLength characters of the alphabet", () => {
    const id = encodeUploadId(Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6]));
    expect(id).toHaveLength(idLength);
    expect(isUploadId(id)).toBeTruthy();
  });

  it("refuses the wrong number of bytes", () => {
    expect(() => encodeUploadId(new Uint8Array(9))).toThrow(RangeError);
    expect(() => encodeUploadId(new Uint8Array(11))).toThrow(RangeError);
  });
});

describe(isUploadId, () => {
  it("accepts sixteen alphabet characters", () => {
    expect(isUploadId("0123456789abcdef")).toBeTruthy();
  });

  it("refuses the wrong length", () => {
    expect(isUploadId("")).toBeFalsy();
    expect(isUploadId("0".repeat(15))).toBeFalsy();
    expect(isUploadId("0".repeat(17))).toBeFalsy();
  });

  it("refuses characters outside the alphabet", () => {
    expect(isUploadId("0123456789abcdei")).toBeFalsy();
    expect(isUploadId("0123456789abcdeU")).toBeFalsy();
    expect(isUploadId("0123456789abcde/")).toBeFalsy();
  });
});
