import { CredentialName } from "@iirc/protocol/line";
import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { parseCertificate } from "./certificate.ts";

const name = CredentialName.make("libera-cert");

// Not real keys: parsing looks at the armour and the base64, never at what the DER says.
const body = "MIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnVu".repeat(3);
const keyBody = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg".repeat(2);

const wrapped = (text: string, width = 64) =>
  (text.match(new RegExp(`.{1,${width}}`, "gu")) ?? []).join("\n");

const block = (label: string, text: string, width = 64) =>
  `-----BEGIN ${label}-----\n${wrapped(text, width)}\n-----END ${label}-----\n`;

const certificate = block("CERTIFICATE", body);
const key = block("PRIVATE KEY", keyBody);

const parsed = (value: string) => {
  const result = parseCertificate(name, Redacted.make(value));

  return result._tag === "Parsed"
    ? {
        certificate: Redacted.value(result.certificate.certificate),
        credential: result.certificate.credential,
        key: Redacted.value(result.certificate.key),
      }
    : result;
};

const refused = (reason: string) => ({ _tag: "Refused", reason });

describe(parseCertificate, () => {
  it.each([
    ["a certificate then its key", certificate + key],
    ["a key then its certificate", key + certificate],
    ["CRLF line endings", (certificate + key).replaceAll("\n", "\r\n")],
    ["text around the blocks", `# my cert\n${certificate}\nsome note\n${key}\n`],
    ["short base64 lines", block("CERTIFICATE", body, 40) + block("PRIVATE KEY", keyBody, 76)],
    ["everything on one line", (certificate + key).trim().replaceAll("\n", " ")],
    ["runs of whitespace between lines", (certificate + key).replaceAll("\n", "\n  \t ")],
  ])("takes %s", (_, value) => {
    expect(parsed(value)).toStrictEqual({
      certificate,
      credential: name,
      key,
    });
  });

  it.each([
    ["an RSA key", "RSA PRIVATE KEY"],
    ["an EC key", "EC PRIVATE KEY"],
  ])("takes %s", (_, label) => {
    expect(parsed(certificate + block(label, keyBody))).toStrictEqual({
      certificate,
      credential: name,
      key: block(label, keyBody),
    });
  });

  it("keeps a chain of certificates, in order", () => {
    const intermediate = block("CERTIFICATE", keyBody);

    expect(parsed(certificate + intermediate + key)).toStrictEqual({
      certificate: certificate + intermediate,
      credential: name,
      key,
    });
  });

  it.each([
    ["nothing", "", "NoCertificate"],
    ["a key only", key, "NoCertificate"],
    ["a certificate only", certificate, "NoKey"],
    [
      "an encrypted key, which needs a passphrase",
      certificate + block("ENCRYPTED PRIVATE KEY", keyBody),
      "NoKey",
    ],
    ["two keys", certificate + key + block("EC PRIVATE KEY", keyBody), "SeveralKeys"],
    [
      "a block that is not base64",
      certificate + key.replace(keyBody.slice(0, 8), "!!not b64"),
      "NoKey",
    ],
    [
      "a block that is never closed",
      certificate + key.replace("-----END PRIVATE KEY-----", ""),
      "NoKey",
    ],
    [
      "a block with an empty body",
      `${certificate}-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n`,
      "NoKey",
    ],
    [
      "a block whose ends disagree",
      certificate + key.replace("END PRIVATE KEY", "END CERTIFICATE"),
      "NoKey",
    ],
  ])("refuses %s", (_, value, reason) => {
    expect(parsed(value)).toStrictEqual(refused(reason));
  });
});
