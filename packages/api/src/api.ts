import { defaultTuning } from "@iirc/lifecycle/tuning";
import type { Tuning as TuningNumbers } from "@iirc/lifecycle/tuning";
import { channelKey, channelPrefixes, joinRejection } from "@iirc/protocol/join";
import { nickLine } from "@iirc/protocol/nick";
import { privmsg, quit, user } from "@iirc/protocol/outbound";
import type { Outbound } from "@iirc/protocol/outbound";
import { buildTemplate, parseTemplate, templateReferences } from "@iirc/protocol/template";
import {
  Context,
  Effect,
  Option,
  pipe,
  Record as Records,
  Redacted,
  Schema,
  SchemaGetter,
} from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";

const maxPageSize = 1000;
const defaultPageSize = "100";
const start = "0";

/** The version of this contract, which `/status` reports (API-5). */
export const apiVersion = 1;

/**
 * How the API parses a body, and how a Frontend should decode a request with this
 * contract's Schemas to get the same answer: a key nothing reads, such as a misspelt Tuning
 * number, is an issue at its path, never a setting silently left out.
 */
export const requestParseOptions = { onExcessProperty: "error" } as const;

const Phase = Schema.Literals([
  "idle",
  "connecting",
  "registering",
  "session",
  "closing",
  "closed",
]);

// Query parameters arrive as text. SQLite reads a negative LIMIT as no limit at all, so
// these bounds are what keep a Frontend from asking for the whole Log.
const IntFromString = Schema.FiniteFromString.check(Schema.isInt());

const Page = {
  after: IntFromString.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(start))
  ),
  limit: IntFromString.check(Schema.isBetween({ maximum: maxPageSize, minimum: 1 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultPageSize))
  ),
};

const Numbered = { at: Schema.Int, sequence: Schema.Int };

/** `pin` is `sha256/` and the base64 SHA-256 of the key's SubjectPublicKeyInfo (CONN-1). */
const Ircd = Schema.Struct({
  host: Schema.String,
  pin: Schema.optionalKey(Schema.String),
  port: Schema.Int,
  tls: Schema.Boolean,
});

/**
 * Every timing and limit a Connection ran with, in milliseconds where it is a time, as its
 * `attempt` recorded them. One for each of lifecycle's numbers, so a new one is here too.
 */
const Tuning = Schema.Struct(
  pipe(
    defaultTuning,
    Records.map(() => Schema.Int)
  )
);

/** How a TLS Connection was secured, and the pin of the key the Ircd presented (CONN-1). */
const TlsDetails = Schema.Struct({
  cipher: Schema.String,
  pin: Schema.String,
  protocol: Schema.String,
  verifiedBy: Schema.Literals(["authority", "pin"]),
});

const Connected = { ...Numbered, ircd: Ircd, network: Schema.String };

const OfConnection = { ...Connected, connection: Schema.Int };

const Lane = Schema.Literals(["control", "interactive", "background"]);

/**
 * Where one Network stands and why (OBS-1, OBS-4). Times are epoch milliseconds. `self`
 * and `joined` describe the current Session, and `closeReason` is in the Ircd's own words
 * when its `ERROR` said why (LIVE-5). `nextAttemptAt` is `null` while a Connection is under way,
 * while the Network is disabled, or while the Daemon is stopping. A rejected Channel is
 * one no `JOIN` can carry, so it is never tried. Between Connections, and while the Log
 * is at fault, `self`, `joined`, and `lagMillis` are empty, because no Session is current.
 * `logFault.retryMillis` is the wait that `retryAt` stands for. `login` is how the current
 * Connection's login to services went, with the service's own words in `text` where it
 * gave any (CONN-6). `missingCredentials` names each Credential the settings refer to that
 * is not set, which keeps the Network from making any `attempt` (CRED-1).
 */
export const NetworkStatus = Schema.Struct({
  closeReason: Schema.NullOr(Schema.String),
  consecutiveFailures: Schema.Int,
  enabled: Schema.Boolean,
  id: Schema.String,
  joinFailures: Schema.Array(
    Schema.Struct({
      at: Schema.Int,
      channel: Schema.String,
      connection: Schema.NullOr(Schema.Int),
      numeric: Schema.String,
      text: Schema.String,
    })
  ),
  joined: Schema.Array(Schema.String),
  kicked: Schema.Array(Schema.Struct({ at: Schema.Int, channel: Schema.String })),
  lagMillis: Schema.NullOr(Schema.Int),
  lanes: Schema.Struct({
    background: Schema.Int,
    control: Schema.Int,
    interactive: Schema.Int,
  }),
  logFault: Schema.NullOr(
    Schema.Struct({ failures: Schema.Int, retryAt: Schema.Int, retryMillis: Schema.Int })
  ),
  login: Schema.Struct({
    state: Schema.Literals(["none", "waiting", "succeeded", "failed", "timedOut"]),
    text: Schema.NullOr(Schema.String),
  }),
  missingCredentials: Schema.Array(Schema.String),
  name: Schema.String,
  nextAttemptAt: Schema.NullOr(Schema.Int),
  phase: Phase,
  rejectedChannels: Schema.Array(
    Schema.Struct({
      channel: Schema.String,
      reason: Schema.Literals(["InvalidChannel", "InvalidKey", "TooLong"]),
    })
  ),
  self: Schema.NullOr(Schema.String),
});

/** The decoded form of {@link NetworkStatus}. */
export type NetworkStatus = typeof NetworkStatus.Type;

/** Where Credentials are kept: the system keyring, or a file in the data directory (CRED-1). */
const CredentialStore = Schema.Literals(["keyring", "file"]);

/**
 * The Daemon and every configured Network at a glance, ordered by ID. `head` is the Log's
 * newest sequence, which is `null` when the Log cannot be read. `credentials.store` says
 * where Credentials are kept (CRED-1).
 */
const Status = Schema.Struct({
  apiVersion: Schema.Literal(apiVersion),
  credentials: Schema.Struct({ store: CredentialStore }),
  head: Schema.NullOr(Schema.Int),
  networks: Schema.Array(NetworkStatus),
  version: Schema.String,
});

/** The decoded form of {@link Status}. */
export type Status = typeof Status.Type;

/**
 * One Entry in the Log. `at` is epoch milliseconds. A Line carries its bytes as base64,
 * because hostile bytes must survive JSON (API-4), beside `text`, their decoded form,
 * and `reason` says why they could not be parsed, if they could not (HOST-1). A Dropped
 * Entry carries the Line that never left in the same way, and its `reason` says why.
 * Either has `redacted`, the names of the Credentials taken out of its bytes, each leaving
 * `<redacted>` in its place, when any were (LOG-6), one name for each `<redacted>` in the
 * order they stand, and `redactedBy`, the sequence of the
 * Change whose `admin` key emptied its bytes, once one has (LOG-7). An `attempt` says how many Lines its
 * login sequence holds and which nicks are services (CONN-6). A Change says who made it,
 * by key name or `local`, and what it changed, as JSON.
 */
export const LogEntry = Schema.Union([
  Schema.TaggedStruct("Line", {
    ...Numbered,
    bytes: Schema.Uint8ArrayFromBase64,
    cause: Schema.optionalKey(Schema.String),
    connection: Schema.Int,
    cut: Schema.optionalKey(Schema.Boolean),
    direction: Schema.Literals(["inbound", "outbound"]),
    network: Schema.String,
    reason: Schema.optionalKey(Schema.Literals(["Empty", "NoCommand"])),
    redacted: Schema.optionalKey(Schema.Array(Schema.String)),
    redactedBy: Schema.optionalKey(Schema.Int),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...Connected,
    loginLines: Schema.Int,
    nicks: Schema.Array(Schema.String),
    phase: Schema.Literal("attempt"),
    realname: Schema.String,
    services: Schema.Array(Schema.String),
    tuning: Tuning,
    username: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...OfConnection,
    phase: Schema.Literal("opened"),
    tls: Schema.optionalKey(TlsDetails),
  }),
  Schema.TaggedStruct("Connection", {
    ...OfConnection,
    chosen: Schema.Boolean,
    phase: Schema.Literal("closing"),
    reason: Schema.String,
  }),
  Schema.TaggedStruct("Connection", {
    ...OfConnection,
    endedAt: Schema.optionalKey(Schema.Int),
    phase: Schema.Literal("closed"),
    reason: Schema.optionalKey(Schema.String),
    /** Only on a close an earlier Daemon took as a refusal. Nothing writes it now (LIVE-5). */
    refused: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Change", {
    ...Numbered,
    by: Schema.String,
    change: Schema.Json,
    network: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Dropped", {
    ...Numbered,
    bytes: Schema.Uint8ArrayFromBase64,
    cause: Schema.String,
    connection: Schema.Int,
    network: Schema.String,
    reason: Schema.String,
    redacted: Schema.optionalKey(Schema.Array(Schema.String)),
    redactedBy: Schema.optionalKey(Schema.Int),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Deadline", {
    ...Numbered,
    name: Schema.String,
    network: Schema.String,
  }),
  Schema.TaggedStruct("Daemon", {
    ...Numbered,
    phase: Schema.Literals(["started", "stopped"]),
    version: Schema.String,
  }),
]);

/** The decoded form of {@link LogEntry}. */
export type LogEntry = typeof LogEntry.Type;

// Keyed by every tag a LogEntry can have, so a new kind cannot compile until a Frontend
// can filter by it too.
const entryKinds = {
  Change: "Change",
  Connection: "Connection",
  Daemon: "Daemon",
  Deadline: "Deadline",
  Dropped: "Dropped",
  Line: "Line",
} as const satisfies { readonly [Kind in LogEntry["_tag"]]: Kind };

const EntryKind = Schema.Literals(Object.values(entryKinds));

// One Network's rows, by its name. No Network is named "", so asking for it is a mistake.
const NetworkFilter = { network: Schema.optionalKey(Schema.NonEmptyString) };

/**
 * Which kinds of Entry to read, as `kind=Line&kind=Daemon` or `kind=Line,Daemon`, or both.
 * Each is a tag of {@link LogEntry}, and anything else is a bad request.
 */
const KindFilter = {
  kind: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(
      Schema.decodeTo(Schema.Array(Schema.String), {
        decode: SchemaGetter.transform((values) => values.flatMap((value) => value.split(","))),
        encode: SchemaGetter.transform((values) => values),
      }),
      Schema.decodeTo(Schema.NonEmptyArray(EntryKind))
    )
  ),
};

/** Something a participant said, with the sequence of the Line that carried it. */
const LoggedMessage = Schema.Struct({
  ...Numbered,
  kind: Schema.Literals(["PRIVMSG", "NOTICE"]),
  network: Schema.String,
  sender: Schema.String,
  target: Schema.String,
  text: Schema.String,
});

/**
 * Time the Daemon was not on a Network, from the `sequence` where it began. An open Gap
 * has no `ended`, which is the `001` that closed it (LIVE-10).
 */
export const Gap = Schema.Struct({
  ...Numbered,
  ended: Schema.optionalKey(Schema.Struct(Numbered)),
  network: Schema.String,
  reason: Schema.String,
});

/** The decoded form of {@link Gap}. */
export type Gap = typeof Gap.Type;

// Text that goes last on a Line, where only a line break or a NUL could break the framing.
const LineText = Schema.String.check(
  Schema.makeFilter((text) => !/[\0\r\n]/u.test(text) || "must not hold a line break or NUL")
);

// Settings are only what protocol's builders can make a Line of, as Channels are, or a
// Network could hold a `QUIT` that is always Dropped, or a `USER` that never registers.
const builds = (outbound: Outbound) => outbound._tag === "Safe";

/**
 * A Network's ID: up to 32 lowercase letters, digits, and `-`, starting with a letter or
 * digit (CONF-3). The Owner chooses it, and history is kept under it.
 */
export const NetworkId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u));

/** The decoded form of {@link NetworkId}. */
export type NetworkId = typeof NetworkId.Type;

/** `sha256/` and the base64 SHA-256 of an Ircd key's SubjectPublicKeyInfo (CONN-1). */
const Pin = Schema.String.check(Schema.isPattern(/^sha256\/[A-Za-z0-9+/]{43}=$/u));

const Port = Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }));

/**
 * Where to reach one of a Network's Ircds. TLS is on unless turned off, and a pinned Ircd
 * is verified by its pin alone, which only means something over TLS (CONN-1).
 */
const IrcdSettings = Schema.Struct({
  host: Schema.String.check(
    Schema.makeFilter(
      (host) => /^[^\s\p{Cc}]+$/u.test(host) || "must be one word, with no control character or NUL"
    )
  ),
  pin: Schema.optionalKey(Pin),
  port: Port.pipe(Schema.withDecodingDefaultKey(Effect.succeed(6697))),
  tls: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
}).check(
  Schema.makeFilter(
    ({ pin, tls }) => pin === undefined || tls || { issue: "a pin needs TLS", path: ["pin"] }
  )
);

// No digit, `-`, or Channel prefix first, and nothing that splits a prefix or a list.
const Nick = Schema.String.check(
  Schema.makeFilter(
    (nick) => builds(nickLine(nick)) || "is not a nick, or is too long for a `NICK` Line"
  )
);

/**
 * Who to be on a Network (CONF-3). The alternates are tried in order (CONN-4). The username
 * and realname are what registration's `USER` carries, so together they must fit in one.
 */
const IdentitySettings = Schema.Struct({
  alternates: Schema.Array(Nick).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  nick: Nick,
  realname: LineText.pipe(Schema.withDecodingDefaultKey(Effect.succeed("iirc"))),
  username: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("iirc"))),
}).check(
  Schema.makeFilter(({ realname, username }) => {
    const built = user(username, realname);

    if (built._tag === "Safe") {
      return true;
    }

    return built.reason === "TooLong"
      ? { issue: "is too long for a `USER` Line", path: ["realname"] }
      : { issue: "must be one word, not starting with a colon", path: ["username"] };
  })
);

/**
 * A Channel name that a `JOIN` Line can carry on its own. It starts with a Channel prefix,
 * so it can never be `0`, which leaves every Channel.
 */
export const ChannelName = Schema.String.check(
  Schema.makeFilter((name) =>
    joinRejection({ name }) === undefined
      ? true
      : `must start with ${channelPrefixes.join(", ")}, and fit in a \`JOIN\` Line`
  )
);

// A default that needs no Effect. Settings can list tens of thousands of Channels, and
// decoding runs on the event loop, where an effectful default per Channel costs far more
// (HOST-5).
const orDefault =
  <S extends Schema.Top>(value: S["Encoded"]) =>
  (self: S) =>
    Schema.optionalKey(Schema.toEncoded(self)).pipe(
      Schema.decodeTo(self, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => value)),
        encode: SchemaGetter.passthrough(),
      })
    );

const credentialNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/**
 * A Credential's name, which Configuration refers to it by (CRED-1): up to 64 lowercase
 * letters, digits, `.`, `_`, and `-`, starting with a letter or digit.
 */
export const CredentialName = Schema.String.check(Schema.isPattern(credentialNamePattern));

/**
 * A Channel in Configuration (CONF-3). Autojoin on means it is wanted, and joined after
 * every burst (LIVE-7). Rejoin-on-kick goes back after a kick (LIVE-8). `key` names the
 * Credential holding its key, and one that is not set is joined without a key (CRED-4).
 */
const ChannelSettings = Schema.Struct({
  autojoin: Schema.Boolean.pipe(orDefault(true)),
  key: Schema.optionalKey(CredentialName),
  name: ChannelName,
  rejoinOnKick: Schema.Boolean.pipe(orDefault(false)),
});

/** The nicks that are services unless the Owner says otherwise (CONF-3). */
export const defaultServices = [
  "NickServ",
  "ChanServ",
  "MemoServ",
  "OperServ",
  "BotServ",
  "HostServ",
  "HelpServ",
] as const;

// A service is someone a `PRIVMSG` can go to, which rules out a list, a space, and a
// leading colon.
const ServiceNick = Schema.String.check(
  Schema.makeFilter(
    (nick) => builds(privmsg(nick, "IDENTIFY")) || "is not a nick a `PRIVMSG` can be sent to"
  )
);

// The account goes before the password in `IDENTIFY`, so a space in it would move the
// password along by a word.
const ServiceAccount = Schema.String.check(
  Schema.makeFilter((account) => /^[^\s\p{Cc}:][^\s\p{Cc}]*$/u.test(account) || "must be one word")
);

/**
 * How Self logs in to services after the burst (CONN-6): `IDENTIFY [account] <password>`
 * to `nick`, which is `NickServ` unless given, with the password by Credential name.
 */
const ServiceLogin = Schema.Struct({
  account: Schema.optionalKey(ServiceAccount),
  nick: ServiceNick.pipe(orDefault("NickServ")),
  password: CredentialName,
});

/**
 * The Credentials a Network uses, each by name (CONF-3, CRED-1): `PASS` (CONN-2), a
 * service login (CONN-6), and a TLS client certificate, which is one PEM holding the
 * certificate and its key.
 */
const CredentialSettings = Schema.Struct({
  clientCertificate: Schema.optionalKey(CredentialName),
  password: Schema.optionalKey(CredentialName),
  service: Schema.optionalKey(ServiceLogin),
});

const isCredentialName = (name: string) => credentialNamePattern.test(name);

/**
 * One connect command (CONN-6): a Line of text in which `{{name}}` stands for the
 * Credential of that name. Each name must be one a Credential can have, and the Line
 * must build with every reference filled in, though the values themselves are only
 * known as it is sent.
 */
const ConnectCommand = Schema.String.check(
  Schema.makeFilter((text) => {
    const unnamed = templateReferences(text).find((name) => !isCredentialName(name));

    if (unnamed !== undefined) {
      return `refers to {{${unnamed}}}, which is not a Credential name`;
    }

    const parsed = parseTemplate(text);

    if (parsed._tag === "Rejected") {
      return parsed.reason === "HasPrefix"
        ? "must not start with tags or a source"
        : "is not a Line";
    }

    const built = buildTemplate(parsed.template, () => "<redacted>");

    return built._tag === "Safe" || `cannot be sent as a Line (${built.reason})`;
  })
);

// What a timer can wait for: past this, one fires at once, so a mistyped wait would turn
// into a redial loop.
const longestWait = 2_147_483_647;

// LIVE-3: a lag check bypasses flood control, so a tiny interval would flood the Ircd.
const shortestLagCheck = 100;

// Every host waits this long at most for its `QUIT` when it stops, and the Daemon stops them
// all at once, so this bounds how long a stop takes whatever the Owner tuned (RUN-3). It is
// well inside the 90 seconds a service manager gives a stop by default.
const longestQuitWait = 10_000;

interface Bounds {
  readonly maximum?: number;
  readonly minimum: number;
}

// One entry for every key of lifecycle's `Tuning` and no other, so a new number cannot go
// without a rule. A wait that gives something time to happen can be 0, and one that paces
// anything cannot. A `QUIT` wait of 0 drops the `QUIT` itself (LIVE-9).
const tuningBounds = {
  burstMillis: { minimum: 0 },
  connectTimeoutMillis: { minimum: 1 },
  controlLaneLimit: { minimum: 1 },
  drainMillis: { minimum: 0 },
  floodBurst: { minimum: 1 },
  floodIntervalMillis: { minimum: 1 },
  joinRetryMillis: { minimum: 1 },
  kickRejoinMillis: { minimum: 0 },
  lagCheckMillis: { minimum: shortestLagCheck },
  laneLimit: { minimum: 1 },
  loginWaitMillis: { minimum: 0 },
  quitWaitMillis: { maximum: longestQuitWait, minimum: 1 },
  reconnectInitialMillis: { minimum: 1 },
  reconnectMaxMillis: { minimum: 1 },
  registrationTimeoutMillis: { minimum: 1 },
  rejoinSettleMillis: { minimum: 0 },
  sendWaitMillis: { minimum: 0 },
  silenceMillis: { minimum: 1 },
  stableAfterMillis: { minimum: 0 },
  writeTimeoutMillis: { minimum: 1 },
} as const satisfies Readonly<Record<keyof TuningNumbers, Bounds>>;

// Each number may be left out, and then runs at the spec's default, which its Schema
// carries for a Frontend to show.
const tuningFields = Records.mapEntries(
  tuningBounds,
  ({ maximum = longestWait, minimum }: Bounds, key) => [
    key,
    Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ maximum, minimum })).annotate({
        default: defaultTuning[key],
      })
    ),
  ]
);

type TuningKey = keyof TuningNumbers;

// `low` must not be above `high`, or, when `strictly`, must be below it. Said of the one
// the Owner set, `high` if both, so that the path is where the fix goes, and against the
// default of the other when it was left out.
const ordered = (low: TuningKey, high: TuningKey, strictly: boolean) =>
  Schema.makeFilter((overrides: Partial<TuningNumbers>) => {
    const tuning = { ...defaultTuning, ...overrides };

    if (strictly ? tuning[low] < tuning[high] : tuning[low] <= tuning[high]) {
      return true;
    }

    const must = strictly ? "must be" : "must not be";

    return overrides[high] === undefined
      ? {
          issue: `${must} ${strictly ? "below" : "above"} ${high}, which is ${tuning[high]}`,
          path: [low],
        }
      : {
          issue: `${must} ${strictly ? "above" : "below"} ${low}, which is ${tuning[low]}`,
          path: [high],
        };
  });

/**
 * The Tuning numbers one Network overrides, by name (CONF-3). Only those the Owner changed
 * are stored, so that a new default reaches every Network that never changed it. Each is a
 * whole number within its bounds, and its default is its `default` annotation. Some numbers
 * are fine alone and wrong beside another, counting the defaults of those left out: a
 * silence no longer than the lag check kills a quiet Ircd every Session, because the check
 * is what makes it speak (LIVE-2), and the first reconnect delay cannot be above the
 * longest (LIVE-4).
 */
export const TuningSettings = Schema.Struct(tuningFields).check(
  ordered("lagCheckMillis", "silenceMillis", true),
  ordered("reconnectInitialMillis", "reconnectMaxMillis", false)
);

/** The decoded form of {@link TuningSettings}. */
export type TuningSettings = typeof TuningSettings.Type;

const settingsFields = {
  channels: Schema.Array(ChannelSettings).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  connectCommands: Schema.Array(ConnectCommand).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  credentials: CredentialSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  id: NetworkId,
  identity: IdentitySettings,
  ircds: Schema.NonEmptyArray(IrcdSettings),
  quitReason: Schema.String.check(
    Schema.makeFilter(
      (reason) => builds(quit(reason)) || "must fit in a `QUIT` Line, with no line break or NUL"
    )
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed("iirc"))),
  /** The nicks that are services, whose `NOTICE` can be a sign of login (CONN-6). */
  services: Schema.Array(ServiceNick).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([...defaultServices]))
  ),
  tuning: TuningSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
};

const DisplayName = Schema.NonEmptyString.check(
  Schema.makeFilter((name) => !/[\0\r\n]/u.test(name) || "must not hold a line break or NUL")
);

// A client certificate is presented in the TLS handshake, so an Ircd without TLS would be
// dialed without it, as someone else.
const certificateNeedsTls = Schema.makeFilter(
  ({
    credentials,
    ircds,
  }: {
    readonly credentials: { readonly clientCertificate?: string };
    readonly ircds: readonly { readonly tls: boolean }[];
  }) => {
    const plain = ircds.findIndex(({ tls }) => !tls);

    return (
      credentials.clientCertificate === undefined ||
      plain === -1 || {
        issue: "must be on, because the Network presents a client certificate",
        path: ["ircds", plain, "tls"],
      }
    );
  }
);

// Where a key first repeats one before it, or -1. A Set keeps it linear, because a body
// can list tens of thousands of Channels, and this runs on the event loop (HOST-5).
const firstRepeat = (keys: readonly string[]) => {
  const seen = new Set<string>();

  return keys.findIndex((key) => seen.size === seen.add(key).size);
};

// Channels are told apart as a host tells them apart, so that no two are one (CONF-3).
const channelsDistinct = Schema.makeFilter(
  ({ channels }: { readonly channels: readonly { readonly name: string }[] }) => {
    const repeated = firstRepeat(channels.map(({ name }) => channelKey(name)));

    return (
      repeated === -1 || {
        issue: "is the same Channel as another",
        path: ["channels", repeated, "name"],
      }
    );
  }
);

/**
 * Everything the Owner wants of one Network (CONF-3), which the Log stores whole with each
 * Change to it. Anything left out takes its default, and the display name is the ID unless
 * given. Credentials appear by name only, here and wherever settings go (CRED-1). It holds
 * every rule the Daemon accepts a Network by, so settings it decodes, with
 * {@link requestParseOptions}, are settings the Daemon will take (CONF-1).
 */
export const NetworkSettings = Schema.toEncoded(
  Schema.Struct({ ...settingsFields, name: Schema.optionalKey(DisplayName) })
).pipe(
  // Checked once, on the way in. Its shape alone is checked before the name is filled in,
  // because checking every Channel twice made a long history slow to start (CONF-1).
  Schema.decodeTo(
    Schema.Struct({ ...settingsFields, name: DisplayName }).check(
      certificateNeedsTls,
      channelsDistinct
    ),
    {
      decode: SchemaGetter.transform((settings) => ({
        ...settings,
        name: settings.name ?? settings.id,
      })),
      encode: SchemaGetter.transform((settings) => settings),
    }
  )
);

/** The decoded form of {@link NetworkSettings}. */
export type NetworkSettings = typeof NetworkSettings.Type;

/** All of Configuration at once (CONF-6), one entry per Network, which no two share. */
export const Configuration = Schema.Struct({
  networks: Schema.Array(NetworkSettings).check(
    Schema.makeFilter((networks) => {
      const repeated = firstRepeat(networks.map(({ id }) => id));

      return repeated === -1 || { issue: "is another Network's ID", path: [repeated, "id"] };
    })
  ),
});

/** The decoded form of {@link Configuration}. */
export type Configuration = typeof Configuration.Type;

/** A Network's Configuration beside what is true of it now. */
const NetworkView = Schema.Struct({ settings: NetworkSettings, status: NetworkStatus });

/**
 * What a key may do (AUTH-3). `read` sees the Log and derived state. `chat` adds sending,
 * joining, and parting. `admin` adds Networks, Configuration, Credentials, backups, and keys.
 */
export const KeyScope = Schema.Literals(["read", "chat", "admin"]);

/** The decoded form of {@link KeyScope}. */
export type KeyScope = typeof KeyScope.Type;

/** What a Change records when it was made by `iirc key create` rather than a key (AUTH-4). */
export const localKeyName = "local";

/**
 * What a Change recorded when an earlier Daemon kept a Channel key that a Network set with
 * `MODE`. No Daemon does now (CRED-4), but a Log can still hold such Changes, so no key may
 * take the name.
 */
export const modeKeyName = "mode";

/**
 * A key's name, which the cause of everything it does carries (LOG-5). `local` stands for
 * `iirc key create`, so no key may take it.
 */
export const KeyName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,31}$/u),
  Schema.makeFilter(
    (name) => name !== localKeyName || "`local` is reserved for what `iirc key create` does"
  ),
  Schema.makeFilter(
    (name) =>
      name !== modeKeyName ||
      "`mode` is reserved for Changes an earlier Daemon made for a Network's `MODE` (CRED-4)"
  )
);

/** A key as anyone may see it, which is never the key itself (AUTH-2). */
const KeyView = Schema.Struct({ created: Schema.Int, name: Schema.String, scope: KeyScope });

/** The most a Credential's value may hold, in UTF-8 bytes: enough for a PEM certificate and key. */
export const maxCredentialBytes = 16 * 1024;

const utf8 = new TextEncoder();

/**
 * A Credential's value, which is `Redacted` from the moment it is decoded (CRED-3). Neither
 * check says what the value was, so a refusal cannot carry it back.
 */
export const CredentialValue = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.makeFilter((value) => value !== "" || "must not be empty"),
    Schema.makeFilter(
      (value) =>
        utf8.encode(value).byteLength <= maxCredentialBytes ||
        `must be at most ${maxCredentialBytes} bytes`
    )
  )
);

/**
 * Every Credential there is, by name, with when each was last set in epoch milliseconds,
 * and where they are kept. A value is never shown (CRED-2).
 */
const Credentials = Schema.Struct({
  credentials: Schema.Array(Schema.Struct({ name: Schema.String, set: Schema.Int })),
  store: CredentialStore,
});

/** A backup of the Log (RUN-2): where it is, how big, and the last sequence it holds. */
const Backup = Schema.Struct({ bytes: Schema.Int, head: Schema.Int, path: Schema.String });

/**
 * What became of a Line the Daemon took (API-9). `written` left, under that sequence.
 * `queued` is still in its lane after the wait, and may yet leave or be Dropped.
 */
const Sent = Schema.Union([
  Schema.Struct({ sequence: Schema.Int, status: Schema.Literal("written") }),
  Schema.Struct({ status: Schema.Literal("queued") }),
]);

/** The sequence of the Change an operation recorded. */
const Changed = Schema.Struct({ change: Schema.Int });

/** There is no Session on the Network to send through. */
export class NotInSession extends Schema.TaggedError<
  NotInSession,
  { readonly brand: unique symbol }
>()("NotInSession", { phase: Phase }, { httpApiStatus: 409 }) {}

/** The Message cannot be sent safely as a Line. */
export class InvalidMessage extends Schema.TaggedError<
  InvalidMessage,
  { readonly brand: unique symbol }
>()(
  "InvalidMessage",
  {
    reason: Schema.Literals([
      "EmptyText",
      "InvalidCommand",
      "InvalidParameter",
      "InvalidTarget",
      "TooLong",
    ]),
  },
  { httpApiStatus: 422 }
) {}

/** The lane holds as many Lines as it may, so nothing was queued (SEND-3). */
export class LaneFull extends Schema.TaggedError<LaneFull, { readonly brand: unique symbol }>()(
  "LaneFull",
  { lane: Lane },
  { httpApiStatus: 429 }
) {}

/** The Line was queued, and its Connection ended before it left (SEND-4). */
export class LineDropped extends Schema.TaggedError<
  LineDropped,
  { readonly brand: unique symbol }
>()("LineDropped", { reason: Schema.String }, { httpApiStatus: 409 }) {}

/** The Line was recorded and its write did not finish, so it may not have reached the Ircd. */
export class WriteFailed extends Schema.TaggedError<
  WriteFailed,
  { readonly brand: unique symbol }
>()("WriteFailed", { reason: Schema.String }, { httpApiStatus: 502 }) {}

/**
 * The Log could not be read or appended to. An append's fault is in `/status` (LOG-9),
 * and a read's is the Log's reader failing, which restarts on its own (LOG-11).
 */
export class LogUnavailable extends Schema.TaggedError<
  LogUnavailable,
  { readonly brand: unique symbol }
>()("LogUnavailable", {}, { httpApiStatus: 503 }) {}

/**
 * The read used up its time budget and was stopped, so it returned nothing (LOG-11). The
 * Log is fine and nothing is in `/status`: ask again, or for less.
 */
export class ReadTimedOut extends Schema.TaggedError<
  ReadTimedOut,
  { readonly brand: unique symbol }
>()("ReadTimedOut", { budgetMillis: Schema.Int }, { httpApiStatus: 503 }) {}

/**
 * The read waited `waitedMillis` behind other reads and was never run (LOG-11). The Log is
 * fine and nothing is in `/status`: the reader is busy, so ask again shortly.
 */
export class ReaderBusy extends Schema.TaggedError<ReaderBusy, { readonly brand: unique symbol }>()(
  "ReaderBusy",
  { waitedMillis: Schema.Int },
  { httpApiStatus: 503 }
) {}

/**
 * A request the API could not read, and what was wrong with it (API-3). Each issue gives
 * where in the request it was, such as `["query", "limit"]` or `["payload", "text"]`.
 */
export class InvalidRequest extends Schema.TaggedError<
  InvalidRequest,
  { readonly brand: unique symbol }
>()(
  "InvalidRequest",
  {
    issues: Schema.Array(
      Schema.Struct({
        message: Schema.String,
        path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
      })
    ),
  },
  { httpApiStatus: 400 }
) {}

/**
 * Turns a request that fails to decode into an {@link InvalidRequest}. It applies to the
 * whole API, so every operation declares it.
 */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "@iirc/api/RequestValidation",
  { error: InvalidRequest }
) {}

/**
 * What a Join produced (API-9). Remembered, it is the Change it recorded, and the
 * reconciler sends the `JOIN` (LOG-5). Not remembered, it is what became of its `JOIN`,
 * which is `skipped` when Self is already in the Channel, so that no duplicate goes.
 */
const Joined = Schema.Union([
  Changed,
  Schema.Struct({ line: Sent }),
  Schema.Struct({
    line: Schema.Struct({
      reason: Schema.Literal("AlreadyJoined"),
      status: Schema.Literal("skipped"),
    }),
  }),
]);

/**
 * A Line that an operation tried to send after its Change was recorded, and could not.
 * The Change stands, so this is part of the answer, not a refusal of it (API-9).
 */
const LineFailed = Schema.Struct({
  error: Schema.Union([LaneFull, LineDropped, LogUnavailable, NotInSession, WriteFailed]),
  status: Schema.Literal("failed"),
});

/**
 * What a Part produced (API-9). A Part that recorded its Change answers with it, and with
 * what became of its `PART`, if Self was in the Channel, which may have `failed` without
 * undoing the Change. A Part of a Channel only Self was in records nothing, so its `PART`
 * is all there is, and a failure of it is the operation's own typed error.
 */
const Parted = Schema.Union([
  Schema.Struct({
    change: Schema.Int,
    line: Schema.optionalKey(Schema.Union([...Sent.members, LineFailed])),
  }),
  Schema.Struct({ line: Sent }),
]);

/** No Entry has that sequence (LOG-7). */
export class EntryNotFound extends Schema.TaggedError<
  EntryNotFound,
  { readonly brand: unique symbol }
>()("EntryNotFound", { sequence: Schema.Int }, { httpApiStatus: 404 }) {}

/** Only a Line or a Dropped Entry has bytes to redact, and this Entry is `kind` (LOG-7). */
export class EntryNotRedactable extends Schema.TaggedError<
  EntryNotRedactable,
  { readonly brand: unique symbol }
>()("EntryNotRedactable", { kind: EntryKind, sequence: Schema.Int }, { httpApiStatus: 409 }) {}

/** The Entry's bytes are already gone, and `change` is the Change that took them (LOG-7). */
export class EntryAlreadyRedacted extends Schema.TaggedError<
  EntryAlreadyRedacted,
  { readonly brand: unique symbol }
>()("EntryAlreadyRedacted", { change: Schema.Int, sequence: Schema.Int }, { httpApiStatus: 409 }) {}

/** No Network has that ID. */
export class NetworkNotFound extends Schema.TaggedError<
  NetworkNotFound,
  { readonly brand: unique symbol }
>()("NetworkNotFound", { network: Schema.String }, { httpApiStatus: 404 }) {}

/** A Network already has that ID, and adding one never replaces another. */
export class NetworkExists extends Schema.TaggedError<
  NetworkExists,
  { readonly brand: unique symbol }
>()("NetworkExists", { network: Schema.String }, { httpApiStatus: 409 }) {}

/** The Channel is neither in Configuration nor one Self is in, so there is nothing to part. */
export class ChannelNotFound extends Schema.TaggedError<
  ChannelNotFound,
  { readonly brand: unique symbol }
>()(
  "ChannelNotFound",
  { channel: Schema.String, network: Schema.String },
  { httpApiStatus: 404 }
) {}

/** A key already has that name, and names are what causes carry (LOG-5). */
export class KeyExists extends Schema.TaggedError<KeyExists, { readonly brand: unique symbol }>()(
  "KeyExists",
  { keyName: Schema.String },
  { httpApiStatus: 409 }
) {}

/** No key has that name. */
export class KeyNotFound extends Schema.TaggedError<
  KeyNotFound,
  { readonly brand: unique symbol }
>()("KeyNotFound", { keyName: Schema.String }, { httpApiStatus: 404 }) {}

/** No Credential has that name. */
export class CredentialNotFound extends Schema.TaggedError<
  CredentialNotFound,
  { readonly brand: unique symbol }
>()("CredentialNotFound", { credential: Schema.String }, { httpApiStatus: 404 }) {}

/**
 * Credentials could not be written where they are kept, so nothing changed and no Change
 * was recorded (CRED-1). `reason` says why, and never holds a value.
 */
export class CredentialsUnavailable extends Schema.TaggedError<
  CredentialsUnavailable,
  { readonly brand: unique symbol }
>()("CredentialsUnavailable", { reason: Schema.String }, { httpApiStatus: 503 }) {}

/** The Log could not be backed up, and `reason` says why (RUN-2). */
export class BackupFailed extends Schema.TaggedError<
  BackupFailed,
  { readonly brand: unique symbol }
>()("BackupFailed", { reason: Schema.String }, { httpApiStatus: 503 }) {}

/**
 * The Daemon is stopping, so it records nothing more, and Configuration stays as it was
 * (RUN-3).
 */
export class Stopping extends Schema.TaggedError<Stopping, { readonly brand: unique symbol }>()(
  "Stopping",
  {},
  { httpApiStatus: 503 }
) {}

/** No key came with the request, or none matches it (AUTH-1, AUTH-2). */
export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()("Unauthorized", {}, { httpApiStatus: 401 }) {}

/** The key is good, and its scope does not reach this operation, which needs `needed` (AUTH-3). */
export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  { needed: KeyScope },
  { httpApiStatus: 403 }
) {}

/** Whose key a request came with, which its handler acts for (LOG-5). */
export class Caller extends Context.Service<
  Caller,
  { readonly name: string; readonly scope: KeyScope }
>()("@iirc/api/Caller") {}

/**
 * The scope an operation needs (AUTH-3). An operation that does not say needs `admin`, so
 * one that was forgotten fails closed.
 */
export const RequiredScope = Context.Reference<KeyScope>("@iirc/api/RequiredScope", {
  defaultValue: () => "admin",
});

/**
 * Checks the key in `Authorization: Bearer`, and nowhere else (AUTH-6), against the scope
 * the operation needs, and provides {@link Caller}. It applies to every operation but
 * `/health`.
 */
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "@iirc/api/Authorization",
  {
    error: [Unauthorized, Forbidden],
    security: { bearer: HttpApiSecurity.bearer },
  }
) {}

/**
 * A Channel key, which is `Redacted` from the moment it is decoded (CRED-3). It is one
 * item of a `JOIN`'s key list, so it holds no space, comma, line break, or NUL.
 */
const ChannelKeyValue = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.makeFilter(
      (key) =>
        (key !== "" && joinRejection({ key, name: "#" }) !== "InvalidKey") ||
        "must be one word, with no comma, line break, or NUL"
    )
  )
);

// A Channel and its key together must fit in one `JOIN`. What is wrong is said without
// the key, so a refusal cannot carry it back.
const joinFits = Schema.makeFilter(
  ({ channel, key }: { readonly channel: string; readonly key?: Redacted.Redacted }) =>
    key === undefined ||
    joinRejection({ key: Redacted.value(key), name: channel }) === undefined || {
      issue: "is too long for a `JOIN` Line with this Channel",
      path: ["key"],
    }
);

// What every Change an operation records can fail with besides its own refusals.
const recording = [LogUnavailable, Stopping];

const reading = [LogUnavailable, ReaderBusy, ReadTimedOut];

const sending = [InvalidMessage, LaneFull, LineDropped, LogUnavailable, NotInSession, WriteFailed];

const NetworkPath = { id: NetworkId };

const CredentialPath = { name: CredentialName };

/** The contract every Frontend drives the Daemon through. */
export class DaemonApi extends HttpApi.make("iirc")
  .add(
    HttpApiGroup.make("health").add(
      HttpApiEndpoint.get("health", "/health", {
        success: Schema.Struct({ status: Schema.Literal("ok") }),
      })
    )
  )
  .add(
    HttpApiGroup.make("daemon")
      .add(
        HttpApiEndpoint.get("status", "/status", { success: Status }).annotate(
          RequiredScope,
          "read"
        ),
        HttpApiEndpoint.get("entries", "/entries", {
          error: reading,
          query: { ...Page, ...NetworkFilter, ...KindFilter },
          success: Schema.Array(LogEntry),
        }).annotate(RequiredScope, "read"),
        HttpApiEndpoint.get("messages", "/messages", {
          error: reading,
          query: { ...Page, ...NetworkFilter },
          success: Schema.Array(LoggedMessage),
        }).annotate(RequiredScope, "read"),
        HttpApiEndpoint.get("gaps", "/gaps", {
          error: reading,
          query: { ...Page, ...NetworkFilter },
          success: Schema.Array(Gap),
        }).annotate(RequiredScope, "read"),
        HttpApiEndpoint.post("send", "/messages", {
          error: [...sending, NetworkNotFound],
          payload: Schema.Struct({
            network: NetworkId,
            target: Schema.String,
            text: Schema.String,
          }),
          success: Sent,
        }).annotate(RequiredScope, "chat"),
        // Empties a Line or a Dropped Entry's bytes, for the day a secret gets through, and
        // records who did as a Change in the same transaction (LOG-7).
        HttpApiEndpoint.post("redact", "/entries/:sequence/redact", {
          error: [...recording, EntryNotFound, EntryNotRedactable, EntryAlreadyRedacted],
          params: { sequence: IntFromString.check(Schema.isGreaterThanOrEqualTo(1)) },
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        // Written by a Worker of its own, into `backups/` in the data directory and nowhere
        // a request could name (RUN-2).
        HttpApiEndpoint.post("backup", "/backup", {
          error: BackupFailed,
          success: Backup,
        }).annotate(RequiredScope, "admin")
      )
      .middleware(Authorization)
  )
  .add(
    HttpApiGroup.make("configuration")
      .add(
        HttpApiEndpoint.get("get", "/configuration", { success: Configuration }).annotate(
          RequiredScope,
          "read"
        ),
        HttpApiEndpoint.put("replace", "/configuration", {
          error: recording,
          payload: Configuration,
          success: Changed,
        }).annotate(RequiredScope, "admin")
      )
      .middleware(Authorization)
  )
  .add(
    HttpApiGroup.make("networks")
      .add(
        HttpApiEndpoint.get("list", "/networks", {
          success: Schema.Array(NetworkView),
        }).annotate(RequiredScope, "read"),
        HttpApiEndpoint.get("get", "/networks/:id", {
          error: NetworkNotFound,
          params: NetworkPath,
          success: NetworkView,
        }).annotate(RequiredScope, "read"),
        HttpApiEndpoint.post("add", "/networks", {
          error: [...recording, NetworkExists],
          payload: NetworkSettings,
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.put("change", "/networks/:id", {
          error: [...recording, NetworkNotFound],
          params: NetworkPath,
          payload: NetworkSettings,
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.delete("remove", "/networks/:id", {
          error: [...recording, NetworkNotFound],
          params: NetworkPath,
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.post("connect", "/networks/:id/connect", {
          error: [...recording, NetworkNotFound],
          params: NetworkPath,
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.post("disconnect", "/networks/:id/disconnect", {
          error: [...recording, NetworkNotFound],
          params: NetworkPath,
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.post("join", "/networks/:id/join", {
          error: [...recording, ...sending, CredentialsUnavailable, NetworkNotFound],
          params: NetworkPath,
          payload: Schema.Struct({
            channel: ChannelName,
            key: Schema.optionalKey(ChannelKeyValue),
            remember: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
          }).check(joinFits),
          success: Joined,
        }).annotate(RequiredScope, "chat"),
        HttpApiEndpoint.post("part", "/networks/:id/part", {
          error: [...recording, ...sending, NetworkNotFound, ChannelNotFound],
          params: NetworkPath,
          payload: Schema.Struct({
            channel: ChannelName,
            reason: Schema.optionalKey(LineText),
          }),
          success: Parted,
        }).annotate(RequiredScope, "chat")
      )
      .middleware(Authorization)
  )
  .add(
    HttpApiGroup.make("keys")
      .add(
        HttpApiEndpoint.get("list", "/keys", { success: Schema.Array(KeyView) }).annotate(
          RequiredScope,
          "admin"
        ),
        HttpApiEndpoint.post("create", "/keys", {
          error: [...recording, KeyExists],
          payload: Schema.Struct({ name: KeyName, scope: KeyScope }),
          success: Schema.Struct({
            change: Schema.Int,
            key: Schema.String,
            name: Schema.String,
            scope: KeyScope,
          }),
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.delete("revoke", "/keys/:name", {
          error: [...recording, KeyNotFound],
          params: { name: Schema.String },
          success: Changed,
        }).annotate(RequiredScope, "admin")
      )
      .middleware(Authorization)
  )
  .add(
    // Write-only: a value goes in, and only its name and when it was set come out (CRED-2).
    HttpApiGroup.make("credentials")
      .add(
        HttpApiEndpoint.get("list", "/credentials", { success: Credentials }).annotate(
          RequiredScope,
          "admin"
        ),
        HttpApiEndpoint.put("set", "/credentials/:name", {
          error: [...recording, CredentialsUnavailable],
          params: CredentialPath,
          payload: Schema.Struct({ value: CredentialValue }),
          success: Changed,
        }).annotate(RequiredScope, "admin"),
        HttpApiEndpoint.delete("delete", "/credentials/:name", {
          error: [...recording, CredentialsUnavailable, CredentialNotFound],
          params: CredentialPath,
          success: Changed,
        }).annotate(RequiredScope, "admin")
      )
      .middleware(Authorization)
  )
  .middleware(RequestValidation)
  .annotate(HttpApi.PayloadParseOptions, requestParseOptions)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "iirc daemon" })) {}
