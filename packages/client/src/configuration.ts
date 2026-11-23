import {
  CredentialName,
  FallbackEncoding,
  IdentifyWord,
  OperName,
  ServiceTarget,
} from "@iirc/protocol/line";
import { IgnoreMask } from "@iirc/protocol/mask";
import { Option, Schema, SchemaGetter } from "effect";

import { FeatureName } from "./ids.ts";
import { quoted } from "./quoted.ts";

/**
 * The annotation of a field a new Network starts with as its first nick, rather than a
 * fixed value, as `realname` and `username` do. A field with a fixed starting value says so
 * with Effect's own `default` annotation, and a field with neither must be given.
 */
export const startsAsFirstNick = { startsAs: "FirstNick" } as const;

/** One Ircd to reach a Network through. */
export const IrcdAddress = Schema.Struct({
  host: Schema.String.check(Schema.isNonEmpty()).annotate({
    description: "The Ircd's host name or IP address.",
  }),
  port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })).annotate({
    description: "The Ircd's port.",
  }),
  tls: Schema.Boolean.annotate({ description: "Whether to connect over TLS." }),
}).annotate({ identifier: "IrcdAddress" });

/** The decoded form of {@link IrcdAddress}. */
export type IrcdAddress = typeof IrcdAddress.Type;

/** The most seconds Channels wait on a service login. */
const maxServiceWait = 60;

/**
 * Which SASL mechanism a login with a password uses: `auto` chooses `SCRAM-SHA-256` where
 * the Ircd lists it and `PLAIN` otherwise, and the others pin one.
 */
export const SaslMechanism = Schema.Literals(["auto", "plain", "scram-sha-256"]);

/** The decoded form of {@link SaslMechanism}. */
export type SaslMechanism = typeof SaslMechanism.Type;

/**
 * How Self logs in to an account: not at all, with SASL before registration ends, with
 * SASL EXTERNAL by the client certificate `tls` names, or by telling a service as a
 * Session begins, where there is no SASL. Whether a failed SASL login ends the Connection
 * is the Owner's choice. A service login never does.
 */
export const Login = Schema.TaggedUnion({
  External: {
    required: Schema.Boolean.annotate({
      default: false,
      description: "Whether a failed login ends the Connection rather than going on without it.",
    }),
  },
  None: {},
  Sasl: {
    account: Schema.String.annotate({
      description: "The account to log in to with SASL.",
      ...startsAsFirstNick,
    }),
    credential: CredentialName.annotate({
      description: "The Credential holding the account's password.",
    }),
    /**
     * A new Network starts with `auto`. A `Configured` written before the field existed
     * decodes as `plain`, since the Client then logged in with `PLAIN`, so replaying an old
     * Journal never tries `SCRAM-SHA-256` where `PLAIN` was used.
     */
    mechanism: Schema.optionalKey(SaslMechanism)
      .pipe(
        Schema.decodeTo(Schema.toType(SaslMechanism), {
          decode: SchemaGetter.transformOptional((given) =>
            Option.orElseSome(given, () => "plain" as const)
          ),
          encode: SchemaGetter.passthrough(),
        })
      )
      .annotate({
        default: "auto",
        description:
          "The SASL mechanism: auto, which uses scram-sha-256 where the Ircd lists it and plain otherwise, or plain or scram-sha-256 alone. A scram-sha-256 login never sends the password, and one that fails never falls back to plain.",
      }),
    required: Schema.Boolean.annotate({
      default: false,
      description: "Whether a failed login ends the Connection rather than going on without it.",
    }),
  },
  Service: {
    account: Schema.optionalKey(
      IdentifyWord.annotate({
        description:
          "The account to log in to by telling the service, one word. Left out, Self tells the service the password alone, which logs in to the account of the nick Self holds.",
      })
    ),
    credential: CredentialName.annotate({
      description: "The Credential holding the account's password.",
    }),
    service: ServiceTarget.annotate({
      default: "NickServ",
      description: "The nick of the service to tell, such as NickServ or NickServ@services.",
    }),
    wait: Schema.Int.check(Schema.isBetween({ maximum: maxServiceWait, minimum: 0 })).annotate({
      default: 5,
      description:
        "How many seconds Channels wait for the Ircd to say Self is logged in, before they are joined anyway.",
    }),
  },
});

/** The decoded form of {@link Login}. */
export type Login = typeof Login.Type;

/**
 * Whether a login is a SASL login, of either kind, that a failed exchange must not go on
 * without.
 * @param login - The login, if there is a Configuration yet.
 * @returns Whether it is a SASL login that is required.
 */
export const saslRequired = (login: Login | undefined): boolean =>
  (login?._tag === "Sasl" || login?._tag === "External") && login.required;

/**
 * Whether Self logs in as an IRC operator, with `OPER`, as each Session begins: not at all,
 * or as a name, with its Credential.
 */
export const Oper = Schema.TaggedUnion({
  Login: {
    credential: CredentialName.annotate({
      description: "The Credential holding the operator's password.",
    }),
    name: OperName.annotate({
      description: "The operator name to send with OPER, one word.",
      ...startsAsFirstNick,
    }),
  },
  None: {},
});

/** The decoded form of {@link Oper}. */
export type Oper = typeof Oper.Type;

const noOper: Oper = { _tag: "None" };

/**
 * Whether Self presents a client certificate when it connects over TLS: not at all, or the
 * one held as a Credential.
 */
export const ClientTls = Schema.TaggedUnion({
  Certificate: {
    certificate: CredentialName.annotate({
      description:
        "The Credential holding a PEM client certificate and its private key, presented when connecting over TLS.",
    }),
  },
  None: {},
});

/** The decoded form of {@link ClientTls}. */
export type ClientTls = typeof ClientTls.Type;

const noTls: ClientTls = { _tag: "None" };

/** A Channel the Owner wants Self in, with its key named as a Credential. */
export const WantedChannel = Schema.Struct({
  key: Schema.optionalKey(
    CredentialName.annotate({ description: "The Credential holding the Channel's key." })
  ),
  name: Schema.String.annotate({ description: "The Channel's name, such as #iirc." }),
});

/** The decoded form of {@link WantedChannel}. */
export type WantedChannel = typeof WantedChannel.Type;

/** How many highlight words a Network may have, and how long each may be. */
const maxHighlights = 64;

/**
 * Words that make a Message a Highlight: at most 64, of at most 64 characters each, since
 * every Message is searched for each, in time linear in its length.
 */
const Highlights = Schema.Array(
  Schema.String.check(Schema.isMaxLength(maxHighlights)).annotate({
    description: "A word that makes a Message a Highlight, of at most 64 characters.",
  })
).check(Schema.isMaxLength(maxHighlights));

/** How many ignore masks a Network may have. */
const maxIgnores = 64;

/**
 * Masks of the Users to ignore: at most 64, since every Message and Activity from a User
 * is matched against each.
 */
const Ignores = Schema.Array(IgnoreMask).check(Schema.isMaxLength(maxIgnores));

/** How many Lines of the Owner's own a Session may begin with. */
const maxLines = 16;

/** A Line written as text, which `/quote` would send. */
const QuotedLine = Schema.String.check(
  Schema.makeFilter((text: string) =>
    quoted(text) === undefined ? "must be a Line /quote would send" : true
  )
);

/**
 * Lines of the Owner's own sent as each Session begins: at most 16, each one that
 * `/quote` would send.
 */
const OwnLines = Schema.Array(QuotedLine).check(Schema.isMaxLength(maxLines));

/** The longest mode string, which fits a `MODE` on Self with any nick an Ircd allows. */
const maxUserModes = 64;

/**
 * User modes to set on Self, as one mode string of at most 64 characters: each `+` or `-`
 * followed by the letters it applies to, such as `+ix-w`, or empty for none. A user mode
 * that takes a parameter is set with a Line of the Owner's own instead.
 */
const UserModes = Schema.String.check(
  Schema.isPattern(/^(?:[+-][A-Za-z]+)*$/u),
  Schema.isMaxLength(maxUserModes)
);

/**
 * What the Owner wants to be true of one Network. It always arrives whole, and the
 * Client works out what changed, so joining, parting, and quitting are all a change of
 * Configuration. Each field says what it is, and what a new Network starts with, in its
 * annotations, which a Frontend reads to offer every field as an option (ADR 0013).
 */
export const NetworkConfiguration = Schema.Struct({
  /**
   * Whether Self answers the CTCP requests an IRC client is expected to. A new Network
   * starts with it on. A `Configured` written before the field existed decodes as off,
   * since the Client then answered nothing, so replaying an old Journal never shows a
   * request as answered that was not.
   */
  answerCtcp: Schema.optionalKey(Schema.Boolean)
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => false)),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: true,
      description:
        "Whether to answer CTCP VERSION, PING, TIME, and CLIENTINFO requests. Off, nothing is answered, and each request is still shown.",
    }),
  /**
   * Whether Self says it is a bot, by setting the user mode the Ircd's `BOT` token names
   * as each Session begins. A `Configured` written before the field existed decodes as
   * off, since the Client then set nothing.
   */
  bot: Schema.optionalKey(Schema.Boolean)
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => false)),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: false,
      description:
        "Whether Self says it is a bot, by setting the bot mode as each Session begins. It is set only where the Ircd names a bot mode.",
    }),
  channels: Schema.Array(WantedChannel).annotate({
    default: [],
    description: "The Channels to be in, joined on connecting and whenever one is added.",
  }),
  /** Features the Owner has turned off, even where an Ircd offers them. */
  declined: Schema.Array(FeatureName).annotate({
    default: [],
    description: "Features to leave off, even where an Ircd offers them, such as echo-message.",
  }),
  enabled: Schema.Boolean.annotate({
    default: true,
    description: "Whether to stay connected to the Network.",
  }),
  /** The WHATWG label to read bytes that are not UTF-8 with, until the Ircd says `UTF8ONLY`. */
  fallbackEncoding: FallbackEncoding.annotate({
    default: "windows-1252",
    description: "The encoding to read text that is not UTF-8 in, until the Ircd says UTF8ONLY.",
  }),
  /**
   * Words that make a Message a Highlight, as Self's nick does. A Journal written before
   * the field existed holds `Configured` inputs without it, which decode as none.
   */
  highlights: Schema.optionalKey(Highlights)
    .pipe(
      Schema.decodeTo(Highlights, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => [])),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: [],
      description:
        "Words that make a Message a Highlight, as Self's nick does, matched as whole words in any case. At most 64, of at most 64 characters each.",
    }),
  /**
   * Masks of the Users to ignore. A Journal written before the field existed holds
   * `Configured` inputs without it, which decode as none.
   */
  ignores: Schema.optionalKey(Schema.Array(Schema.String))
    .pipe(
      Schema.decodeTo(Ignores, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => [])),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: [],
      description:
        "Users to ignore, each by a mask such as nick!user@host, in which * and ? match anything. What they say is kept, but not shown, counted, or notified. At most 64.",
    }),
  ircds: Schema.NonEmptyArray(IrcdAddress).annotate({
    description: "The Ircds to connect to, tried in turn.",
  }),
  /**
   * Lines the Owner sends as each Session begins. A Journal written before the field
   * existed holds `Configured` inputs without it, which decode as none.
   */
  lines: Schema.optionalKey(Schema.Array(Schema.String))
    .pipe(
      Schema.decodeTo(OwnLines, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => [])),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: [],
      description:
        "Lines to send as each Session begins, written as /quote takes them, in order, after any login and before Channels are joined. At most 16. They are kept in the clear, so put no password in one.",
    }),
  login: Login.annotate({
    default: { _tag: "None" },
    description:
      "How to log in to an account: none, sasl, external, which uses SASL EXTERNAL by the client certificate and needs tls.certificate, or service, which tells a service such as NickServ. The options under it say the rest.",
  }),
  nicks: Schema.NonEmptyArray(Schema.String).annotate({
    description: "The nicks to use, the first preferred and the rest tried in turn.",
  }),
  /**
   * Whether Self opers as each Session begins. A `Configured` written before the field
   * existed decodes as none, since the Client then sent no `OPER`.
   */
  oper: Schema.optionalKey(Oper)
    .pipe(
      Schema.decodeTo(Schema.toType(Oper), {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => noOper)),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: noOper,
      description:
        "Whether to log in as an IRC operator as each Session begins: none, or login, with the options under it.",
    }),
  password: Schema.optionalKey(
    CredentialName.annotate({
      description: "The Credential holding the Ircd's password, sent as PASS, if it needs one.",
    })
  ),
  realname: Schema.String.annotate({
    description: "The real name other Users see in WHOIS.",
    ...startsAsFirstNick,
  }),
  /**
   * Whether Self presents a client certificate over TLS. A `Configured` written before the
   * field existed decodes as none, since the Client then named no certificate.
   */
  tls: Schema.optionalKey(ClientTls)
    .pipe(
      Schema.decodeTo(Schema.toType(ClientTls), {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => noTls)),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: noTls,
      description:
        "Whether to present a client certificate when connecting over TLS: none, or certificate, with the Credential under it.",
    }),
  /**
   * User modes to set on Self as each Session begins. A Journal written before the field
   * existed holds `Configured` inputs without it, which decode as none.
   */
  userModes: Schema.optionalKey(Schema.String)
    .pipe(
      Schema.decodeTo(UserModes, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => "")),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: "",
      description:
        "User modes to set on Self as each Session begins, such as +ix-w, before any of the Lines are sent. At most 64 characters. Empty sets none.",
    }),
  username: Schema.String.annotate({
    description: "The username, the part of Self's mask before the @.",
    ...startsAsFirstNick,
  }),
  /**
   * Whether Self asks who is in each Channel on joining it. A new Network starts with it
   * on. A `Configured` written before the field existed decodes as off, since the Client
   * then asked nothing, so replaying an old Journal sends no `WHO` it did not.
   */
  whoOnJoin: Schema.optionalKey(Schema.Boolean)
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transformOptional((given) => Option.orElseSome(given, () => false)),
        encode: SchemaGetter.passthrough(),
      })
    )
    .annotate({
      default: true,
      description:
        "Whether to ask who is in each Channel on joining it, to learn who is away and who is logged in. Turn it off for a Network whose Channels are so large that asking is rude.",
    }),
}).check(
  Schema.makeFilter((configuration) =>
    configuration.login._tag === "External" && configuration.tls._tag !== "Certificate"
      ? "login external needs tls.certificate"
      : true
  )
);

/** The decoded form of {@link NetworkConfiguration}. */
export type NetworkConfiguration = typeof NetworkConfiguration.Type;

const echoMessage = FeatureName.make("echo-message");

/**
 * The Features a Configuration declines: those the Owner named.
 * @param configuration - The Configuration, if there is one yet.
 * @returns Their names.
 */
export const declinedOf = (
  configuration: NetworkConfiguration | undefined
): readonly FeatureName[] => configuration?.declined ?? [];

/**
 * The Features a Configuration declines when asking for caps: those the Owner named, and
 * `echo-message` with a service login, since the Ircd would echo the Credential back, and
 * every Line received is journaled. It only stops the cap being asked for. A Connection
 * that already has it keeps the Feature on, so each echo is still matched to its Message.
 * @param configuration - The Configuration, if there is one yet.
 * @returns Their names.
 */
export const declinedToRequest = (
  configuration: NetworkConfiguration | undefined
): readonly FeatureName[] => {
  const declined = declinedOf(configuration);

  return configuration?.login._tag === "Service" && !declined.includes(echoMessage)
    ? [...declined, echoMessage]
    : declined;
};

/**
 * The Credentials a Configuration names: its Ircd password, its login's, its client
 * certificate's, its operator's, and each Channel's key.
 * @param configuration - The Configuration.
 * @returns Their names.
 */
export const credentialsOf = (configuration: NetworkConfiguration): ReadonlySet<CredentialName> =>
  new Set([
    ...(configuration.password === undefined ? [] : [configuration.password]),
    ...("credential" in configuration.login ? [configuration.login.credential] : []),
    ...(configuration.tls._tag === "Certificate" ? [configuration.tls.certificate] : []),
    ...(configuration.oper._tag === "None" ? [] : [configuration.oper.credential]),
    ...configuration.channels.flatMap((channel) =>
      channel.key === undefined ? [] : [channel.key]
    ),
  ]);
