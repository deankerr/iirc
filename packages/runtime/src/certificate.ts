/**
 * Parses a Credential's value into a client certificate, as PEM. It is pure string work:
 * whether the key matches the certificate is for TLS to say.
 *
 * @packageDocumentation
 */
import type { CredentialName } from "@iirc/protocol/line";
import { Redacted } from "effect";

import type { ClientCertificate } from "./transport.ts";

/** Why a value is not a client certificate. */
type CertificateRefusal = "NoCertificate" | "NoKey" | "SeveralKeys";

/** A value parsed, or why it could not be. */
export type Parsed =
  | { readonly _tag: "Parsed"; readonly certificate: ClientCertificate }
  | { readonly _tag: "Refused"; readonly reason: CertificateRefusal };

const keyLabels: ReadonlySet<string> = new Set([
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
]);

// A block's ends must name the same thing. Whitespace in it, whether line ends, spaces, or
// both, is only layout, since a pasted PEM may have been folded onto one line.
const armoured = /-----BEGIN (?<label>[A-Z ]+)-----(?<body>[^-]*)-----END \k<label>-----/gu;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const canonical = (label: string, body: string) =>
  `-----BEGIN ${label}-----\n${(body.match(/.{1,64}/gu) ?? []).join("\n")}\n-----END ${label}-----\n`;

/**
 * Finds the certificate chain and the private key in a Credential's value, and writes each
 * block again in canonical PEM, with its base64 in lines of 64 characters. Anything outside
 * a block is dropped, as is a block of another kind, such as an encrypted key.
 * @param credential - The Credential's name, which the result carries for logging.
 * @param value - The Credential's value.
 * @returns The certificate, or why the value has none.
 */
export const parseCertificate = (credential: CredentialName, value: Redacted.Redacted): Parsed => {
  const certificates: string[] = [];
  const keys: string[] = [];

  for (const found of Redacted.value(value).matchAll(armoured)) {
    const { label = "", body: raw = "" } = found.groups ?? {};
    const body = raw.replaceAll(/\s+/gu, "");

    if (!base64.test(body)) {
      continue;
    }

    if (label === "CERTIFICATE") {
      certificates.push(canonical(label, body));
    } else if (keyLabels.has(label)) {
      keys.push(canonical(label, body));
    }
  }

  if (certificates.length === 0) {
    return { _tag: "Refused", reason: "NoCertificate" };
  }

  const [key, ...others] = keys;

  if (key === undefined) {
    return { _tag: "Refused", reason: "NoKey" };
  }

  if (others.length > 0) {
    return { _tag: "Refused", reason: "SeveralKeys" };
  }

  return {
    _tag: "Parsed",
    certificate: {
      certificate: Redacted.make(certificates.join("")),
      credential,
      key: Redacted.make(key),
    },
  };
};
