import { KeyScope } from "@iirc/api";
import { casemappings, defaultTuningNumbers } from "@iirc/lifecycle/tuning";
import type { Json } from "@iirc/session/entry";
import { Option, Record as Records, Schema, SchemaGetter } from "effect";

// A Change is read for what it meant when the Daemon recorded it, which is not the same
// question as whether the Daemon would accept it today (ADR 0004). The API's Schemas hold
// a request to today's rules, and nothing here does: a Change those rules accepted once
// must fold for as long as the Log keeps it, however they tighten, or one old Entry, long
// since replaced, could keep an always-on Daemon from starting (CONF-1). So each field is
// only its shape, and a field added since some Changes were recorded takes the value that
// those Changes meant, written out here rather than borrowed from the API, so that a new
// default there cannot rewrite history. Explicit versions wait for a change of meaning
// that a default cannot express.

// What a field a Change left out meant then. It needs no Effect, because settings can list
// tens of thousands of Channels, and a long history is folded at every start (HOST-5).
const orDefault =
  <S extends Schema.Top>(value: S["Type"]) =>
  (self: S) =>
    Schema.optionalKey(Schema.toEncoded(self)).pipe(
      Schema.decodeTo(self, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => value)),
        encode: SchemaGetter.passthrough(),
      })
    );

const Ircd = Schema.Struct({
  host: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  port: Schema.Int.pipe(orDefault(6697)),
  tls: Schema.Boolean.pipe(orDefault(true)),
});

const Identity = Schema.Struct({
  alternates: Schema.Array(Schema.String).pipe(orDefault([])),
  nick: Schema.String,
  realname: Schema.String.pipe(orDefault("iirc")),
  username: Schema.String.pipe(orDefault("iirc")),
});

const Channel = Schema.Struct({
  autojoin: Schema.Boolean.pipe(orDefault(true)),
  key: Schema.optionalKey(Schema.String),
  name: Schema.String,
  rejoinOnKick: Schema.Boolean.pipe(orDefault(false)),
});

const Credentials = Schema.Struct({
  clientCertificate: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(
    Schema.Struct({
      account: Schema.optionalKey(Schema.String),
      nick: Schema.String.pipe(orDefault("NickServ")),
      password: Schema.String,
    })
  ),
});

// The Tuning there is now. A number that has since gone is dropped, since nothing runs it,
// and only today's defaults stand under those kept, as CONF-3 says. A Change from before the
// encoding, the casemapping, and the CTCP switches existed left them out, which meant no
// fallback, the Ircd's own mapping, and today's defaults, as leaving them out still does.
// An encoding label is folded as it was recorded, whether or not this runtime knows it.
const Tuning = Schema.Struct({
  ...Records.mapEntries(defaultTuningNumbers, (_default, key) => [
    key,
    Schema.optionalKey(Schema.Int),
  ]),
  casemapping: Schema.optionalKey(Schema.Literals(casemappings)),
  ctcpPing: Schema.optionalKey(Schema.Boolean),
  ctcpTime: Schema.optionalKey(Schema.Boolean),
  ctcpVersion: Schema.optionalKey(Schema.Boolean),
  encoding: Schema.optionalKey(Schema.String),
});

// A Change from before a Network had services listed them as these.
const servicesBefore = [
  "NickServ",
  "ChanServ",
  "MemoServ",
  "OperServ",
  "BotServ",
  "HostServ",
  "HelpServ",
];

const settingsFields = {
  channels: Schema.Array(Channel).pipe(orDefault([])),
  connectCommands: Schema.Array(Schema.String).pipe(orDefault([])),
  credentials: Credentials.pipe(orDefault({})),
  enabled: Schema.Boolean.pipe(orDefault(true)),
  id: Schema.String,
  identity: Identity,
  ircds: Schema.NonEmptyArray(Ircd),
  quitReason: Schema.String.pipe(orDefault("iirc")),
  services: Schema.Array(Schema.String).pipe(orDefault(servicesBefore)),
  tuning: Tuning.pipe(orDefault({})),
};

/**
 * A Network's settings as a Change recorded them. Its decoded form is the API's
 * `NetworkSettings`, which the fold runs on, so the compiler finds any setting the API
 * gains that history does not say how to read.
 */
const Settings = Schema.toEncoded(
  Schema.Struct({ ...settingsFields, name: Schema.optionalKey(Schema.String) })
).pipe(
  Schema.decodeTo(Schema.Struct({ ...settingsFields, name: Schema.String }), {
    decode: SchemaGetter.transform((settings) => ({
      ...settings,
      name: settings.name ?? settings.id,
    })),
    encode: SchemaGetter.transform((settings) => settings),
  })
);

/**
 * What the Owner altered, as a Change Entry stores it (CONF-1, LOG-2). Each Network's
 * settings are whole, so that a Change can be read alone. A key is stored only as its
 * SHA-256 (AUTH-2), and a Credential only by name (CRED-1). This is the Log's format, read
 * leniently and historically: only a Change of no known kind, or one without the shape its
 * kind always had, cannot be read, and the Daemon will not start on one (CONF-1).
 */
const StoredChange = Schema.Union([
  Schema.TaggedStruct("NetworkAdded", { settings: Settings }),
  Schema.TaggedStruct("NetworkChanged", { settings: Settings }),
  Schema.TaggedStruct("NetworkRemoved", { id: Schema.String }),
  /** Enabled on, and a retry now (LIVE-4). */
  Schema.TaggedStruct("NetworkConnected", { id: Schema.String }),
  /** Enabled off (LIVE-9). */
  Schema.TaggedStruct("NetworkDisconnected", { id: Schema.String }),
  /**
   * Wanted, with autojoin on, as of this Change, which outranks an older kick (LIVE-8).
   * `key` names the Credential holding its key, which a Join given one stored first
   * (CRED-4). Without one, a key the Channel already had stays.
   */
  Schema.TaggedStruct("ChannelJoined", {
    channel: Schema.Struct({
      key: Schema.optionalKey(Schema.String),
      name: Schema.String,
      rejoinOnKick: Schema.optionalKey(Schema.Boolean),
    }),
    network: Schema.String,
  }),
  Schema.TaggedStruct("ChannelParted", { channel: Schema.String, network: Schema.String }),
  /**
   * A configured Channel's key is now held under `key`, because the Daemon stored one it
   * saw set with `+k` (CRED-4). It changes nothing else about the Channel: not autojoin,
   * not a kick, and not when it was last wanted.
   */
  Schema.TaggedStruct("ChannelKeyNamed", {
    channel: Schema.String,
    key: Schema.String,
    network: Schema.String,
  }),
  /**
   * The whole of Configuration at once, as an import is (CONF-6). Were one ID listed twice,
   * the later would stand.
   */
  Schema.TaggedStruct("ConfigurationReplaced", { networks: Schema.Array(Settings) }),
  // A scope says what a key may do, so one this Daemon does not know cannot be read.
  Schema.TaggedStruct("KeyCreated", { hash: Schema.String, name: Schema.String, scope: KeyScope }),
  Schema.TaggedStruct("KeyRevoked", { hash: Schema.String, name: Schema.String, scope: KeyScope }),
  /** Set or replaced, once it was kept. Its value never comes near the Log (CRED-1). */
  Schema.TaggedStruct("CredentialSet", { name: Schema.String }),
  Schema.TaggedStruct("CredentialDeleted", { name: Schema.String }),
  /** The bytes of the Line or Dropped Entry at `sequence` were emptied (LOG-7). */
  Schema.TaggedStruct("EntryRedacted", { sequence: Schema.Int }),
]);

/**
 * A Change, as the Daemon folds it into Configuration. One the Daemon makes now has been
 * accepted by the API's Schemas on the way in, and one read back from the Log is whatever
 * it was when recorded.
 */
export type Change = typeof StoredChange.Type;

const ChangeJson = Schema.toCodecJson(StoredChange);

/** Writes a Change as the JSON its Entry stores. */
export const encodeChange: (change: Change) => Json = Schema.encodeSync(ChangeJson);

/**
 * Reads a Change from the JSON its Entry stored, as it meant then, or says why it cannot.
 * It never asks whether the Daemon would accept the Change today.
 */
export const decodeStoredChange = Schema.decodeUnknownResult(ChangeJson);

/**
 * The Network a Change concerns, which its Entry carries so that a Network's history
 * can be read alone (LOG-2).
 * @param change - The Change.
 * @returns The Network's ID, or nothing for a Change to the whole Daemon.
 */
export const networkOf = (change: Change): string | undefined => {
  switch (change._tag) {
    case "NetworkAdded":
    case "NetworkChanged": {
      return change.settings.id;
    }

    case "NetworkRemoved":
    case "NetworkConnected":
    case "NetworkDisconnected": {
      return change.id;
    }

    case "ChannelJoined":
    case "ChannelKeyNamed":
    case "ChannelParted": {
      return change.network;
    }

    // A Credential belongs to no one Network: any number may refer to it. A redaction
    // names only the Entry, whose own Network is on it.
    case "ConfigurationReplaced":
    case "CredentialDeleted":
    case "CredentialSet":
    case "EntryRedacted":
    case "KeyCreated":
    case "KeyRevoked": {
      return undefined;
    }

    default: {
      return change satisfies never;
    }
  }
};
