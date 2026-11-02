import { joinBatches } from "@iirc/protocol/join";
import type { JoinBatch, JoinBatches } from "@iirc/protocol/join";
import { outbound, privmsg } from "@iirc/protocol/outbound";
import type { Outbound, OutboundLine } from "@iirc/protocol/outbound";
import {
  buildTemplate,
  fillReferences,
  parseTemplate,
  templateReferences,
} from "@iirc/protocol/template";
import { Redacted } from "effect";

import { redactedText } from "./redact.ts";
import type { Secrets, Sensitive } from "./redact.ts";

/** How Self logs in to services, with the password by Credential name (CONN-6). */
export interface ServiceLogin {
  /** Sent before the password, for services that log in to an account by name. */
  readonly account?: string;
  /** The service to send `IDENTIFY` to, such as `NickServ`. */
  readonly nick: string;
  readonly password: string;
}

/** The Credentials a Network uses, each by its name (CONF-3). */
export interface CredentialNames {
  /** A PEM holding a TLS client certificate and its key. */
  readonly clientCertificate?: string;
  /** Sent as `PASS` before anything else (CONN-2). */
  readonly password?: string;
  readonly service?: ServiceLogin;
}

/** The cause of the `IDENTIFY` that the login sequence starts with (LOG-5). */
export const identifyCause = "identify";

/** The cause of each connect command (LOG-5). */
export const connectCommandCause = "connect-command";

/** The causes of the login sequence, whose last Line starts the login wait (CONN-6). */
export const loginCauses: ReadonlySet<string> = new Set([identifyCause, connectCommandCause]);

/**
 * A Line ready to queue, with what the Log records in its place if it holds Credentials,
 * or why it cannot be sent, with what the Log records of it as Dropped (LOG-6).
 */
export type Built =
  | { readonly _tag: "Safe"; readonly line: OutboundLine; readonly sensitive?: Sensitive }
  | { readonly _tag: "Unsendable"; readonly reason: string; readonly recorded: Sensitive };

const encoder = new TextEncoder();

/**
 * The names of the Credentials a connect command refers to, each once, in order.
 * @param template - The connect command, in which `{{name}}` stands for a Credential.
 * @returns The names.
 */
export const credentialReferences = (template: string): readonly string[] =>
  templateReferences(template);

const namedIn = ({
  connectCommands,
  credentials,
}: {
  readonly connectCommands: readonly string[];
  readonly credentials: CredentialNames;
}) => [
  ...new Set([
    ...(credentials.password === undefined ? [] : [credentials.password]),
    ...(credentials.service === undefined ? [] : [credentials.service.password]),
    ...(credentials.clientCertificate === undefined ? [] : [credentials.clientCertificate]),
    ...connectCommands.flatMap(credentialReferences),
  ]),
];

/**
 * The Credentials that settings refer to and that are not set, which keep a Network from
 * making any `attempt` (CRED-1). A Channel key is not among them, because a Channel whose
 * key is missing is joined without one.
 * @param settings - What a Network refers to, and every Credential there is.
 * @returns The missing names, each once, in the order the settings name them.
 */
export const missingCredentials = (settings: {
  readonly connectCommands: readonly string[];
  readonly credentials: CredentialNames;
  readonly secrets: Secrets;
}): readonly string[] => namedIn(settings).filter((name) => !settings.secrets.has(name));

const valueOf = (secrets: Secrets, name: string) => {
  const value = secrets.get(name);

  return value === undefined ? undefined : Redacted.value(value);
};

const recordedAs = (text: string, names: readonly string[]): Sensitive => ({
  bytes: encoder.encode(text),
  names,
});

// What the Log keeps is the Line built with each value as `<redacted>`, which a builder
// can refuse for its length alone, so it falls back to the text it was built from.
const recordedFrom = (built: Outbound, text: string, names: readonly string[]): Sensitive =>
  built._tag === "Safe" ? { bytes: built.line.bytes, names } : recordedAs(text, names);

const notSet = (name: string) => `the Credential ${name} is not set`;

const fromBuilt = (built: Outbound, recorded: Sensitive): Built =>
  built._tag === "Safe"
    ? { _tag: "Safe", line: built.line, sensitive: recorded }
    : { _tag: "Unsendable", reason: built.reason, recorded };

/**
 * Builds `PASS`, which registration sends first (CONN-2).
 * @param name - The Credential holding the password.
 * @param secrets - Every Credential there is.
 * @returns The Line, sensitive, or why it cannot be sent.
 */
export const passLine = (name: string, secrets: Secrets): Built => {
  const recorded = recordedAs(`PASS ${redactedText}`, [name]);
  const password = valueOf(secrets, name);

  return password === undefined
    ? { _tag: "Unsendable", reason: notSet(name), recorded }
    : fromBuilt(outbound("PASS", [password]), recorded);
};

const identifyText = ({ account }: ServiceLogin, password: string) =>
  account === undefined ? `IDENTIFY ${password}` : `IDENTIFY ${account} ${password}`;

/**
 * Builds the `IDENTIFY` to a service that starts the login sequence (CONN-6).
 * @param service - The service, and the Credential holding the password.
 * @param secrets - Every Credential there is.
 * @returns The Line, sensitive, or why it cannot be sent.
 */
export const identifyLine = (service: ServiceLogin, secrets: Secrets): Built => {
  const { nick, password: name } = service;
  const shown = identifyText(service, redactedText);
  const recorded = recordedFrom(privmsg(nick, shown), `PRIVMSG ${nick} :${shown}`, [name]);
  const password = valueOf(secrets, name);

  return password === undefined
    ? { _tag: "Unsendable", reason: notSet(name), recorded }
    : fromBuilt(privmsg(nick, identifyText(service, password)), recorded);
};

/**
 * Builds one connect command, a Line of text in which `{{name}}` stands for the
 * Credential of that name (CONN-6). It is parsed before anything is put in, so a value
 * cannot add a parameter or a command of its own, and one that would break the Line is
 * refused. A command that refers to a Credential is sensitive (LOG-6).
 * @param template - The connect command.
 * @param secrets - Every Credential there is.
 * @returns The Line, or why it cannot be sent.
 */
export const connectCommandLine = (template: string, secrets: Secrets): Built => {
  const names = credentialReferences(template);
  const parsed = parseTemplate(template);
  const shownText = fillReferences(template, () => redactedText);

  if (parsed._tag === "Rejected") {
    return { _tag: "Unsendable", reason: "not a Line", recorded: recordedAs(shownText, names) };
  }

  const recorded = recordedFrom(
    buildTemplate(parsed.template, () => redactedText),
    shownText,
    names
  );

  const absent = names.find((name) => !secrets.has(name));

  if (absent !== undefined) {
    return { _tag: "Unsendable", reason: notSet(absent), recorded };
  }

  const built = buildTemplate(parsed.template, (name) => valueOf(secrets, name) ?? "");

  if (names.length > 0) {
    return fromBuilt(built, recorded);
  }

  return built._tag === "Safe"
    ? { _tag: "Safe", line: built.line }
    : { _tag: "Unsendable", reason: built.reason, recorded };
};

/** A Channel to join with its key's value, and the name of the Credential it came from. */
export interface KeyedChannel {
  /** The Credential its key came from, if it has one. */
  readonly credential?: string;
  readonly key?: string;
  readonly name: string;
}

// Each Channel gets the value of its key's Credential (CRED-4), and one whose key is not
// set is joined without a key.
const withKeys = (
  channels: readonly { readonly key?: string | undefined; readonly name: string }[],
  secrets: Secrets
): readonly KeyedChannel[] =>
  channels.map(({ key: credential, name }) => {
    const key = credential === undefined ? undefined : valueOf(secrets, credential);

    return key === undefined || credential === undefined ? { name } : { credential, key, name };
  });

/**
 * Batches Channels into `JOIN` Lines with their keys, keyed Channels first (SEND-11).
 * @param channels - Each Channel, with its key by Credential name.
 * @param secrets - Every Credential there is.
 * @returns The Lines with what each carries, and the Channels none could carry.
 */
export const keyedJoins = (
  channels: readonly { readonly key?: string | undefined; readonly name: string }[],
  secrets: Secrets
): JoinBatches<KeyedChannel> => joinBatches(withKeys(channels, secrets));

/**
 * What the Log records for a `JOIN` in place of its bytes, when it carries keys: each key
 * as `<redacted>`, so the Channels it asked for still show (LOG-6).
 * @param batch - The `JOIN` Line, and the Channels it carries.
 * @returns The sensitive form, or nothing for a `JOIN` with no key.
 */
export const joinSensitive = ({ channels }: JoinBatch<KeyedChannel>): Sensitive | undefined => {
  const names = channels.flatMap(({ credential, key }) =>
    credential === undefined || key === undefined || key === "" ? [] : [credential]
  );

  if (names.length === 0) {
    return undefined;
  }

  const shown = names.map(() => redactedText).join(",");

  return recordedAs(`JOIN ${channels.map(({ name }) => name).join(",")} ${shown}`, [
    ...new Set(names),
  ]);
};
