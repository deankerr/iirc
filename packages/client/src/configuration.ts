import { CredentialName } from "@iirc/protocol/line";
import { Schema } from "effect";

import { FeatureName } from "./ids.ts";

/** One Ircd to reach a Network through. */
export const IrcdAddress = Schema.Struct({
  host: Schema.String,
  port: Schema.Int,
  tls: Schema.Boolean,
});

/** The decoded form of {@link IrcdAddress}. */
export type IrcdAddress = typeof IrcdAddress.Type;

/** How Self logs in to an account. Whether a failed login ends the Connection is the Owner's choice. */
export const Login = Schema.TaggedUnion({
  None: {},
  Sasl: { account: Schema.String, credential: CredentialName, required: Schema.Boolean },
});

/** The decoded form of {@link Login}. */
export type Login = typeof Login.Type;

/** A Channel the Owner wants Self in, with its key named as a Credential. */
export const WantedChannel = Schema.Struct({
  key: Schema.optionalKey(CredentialName),
  name: Schema.String,
});

/** The decoded form of {@link WantedChannel}. */
export type WantedChannel = typeof WantedChannel.Type;

/**
 * What the Owner wants to be true of one Network. It always arrives whole, and the
 * Client works out what changed, so joining, parting, and quitting are all a change of
 * Configuration.
 */
export const NetworkConfiguration = Schema.Struct({
  channels: Schema.Array(WantedChannel),
  /** Features the Owner has turned off, even where an Ircd offers them. */
  declined: Schema.Array(FeatureName),
  enabled: Schema.Boolean,
  /** The WHATWG label to read bytes that are not UTF-8 with, until the Ircd says `UTF8ONLY`. */
  fallbackEncoding: Schema.String,
  ircds: Schema.NonEmptyArray(IrcdAddress),
  login: Login,
  nicks: Schema.NonEmptyArray(Schema.String),
  password: Schema.optionalKey(CredentialName),
  realname: Schema.String,
  username: Schema.String,
});

/** The decoded form of {@link NetworkConfiguration}. */
export type NetworkConfiguration = typeof NetworkConfiguration.Type;
