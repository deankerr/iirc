import { CredentialName, FallbackEncoding } from "@iirc/protocol/line";
import { Option, Schema, SchemaGetter } from "effect";

import { FeatureName } from "./ids.ts";

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

/** How Self logs in to an account. Whether a failed login ends the Connection is the Owner's choice. */
export const Login = Schema.TaggedUnion({
  None: {},
  Sasl: {
    account: Schema.String.annotate({
      description: "The account to log in to with SASL PLAIN.",
      ...startsAsFirstNick,
    }),
    credential: CredentialName.annotate({
      description: "The Credential holding the account's password.",
    }),
    required: Schema.Boolean.annotate({
      default: false,
      description: "Whether a failed login ends the Connection rather than going on without it.",
    }),
  },
});

/** The decoded form of {@link Login}. */
export type Login = typeof Login.Type;

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

/**
 * What the Owner wants to be true of one Network. It always arrives whole, and the
 * Client works out what changed, so joining, parting, and quitting are all a change of
 * Configuration. Each field says what it is, and what a new Network starts with, in its
 * annotations, which a Frontend reads to offer every field as an option (ADR 0013).
 */
export const NetworkConfiguration = Schema.Struct({
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
        "Words that make a Message a Highlight, as Self's nick does, matched as whole words in any case: at most 64, of at most 64 characters each.",
    }),
  ircds: Schema.NonEmptyArray(IrcdAddress).annotate({
    description: "The Ircds to connect to, tried in turn.",
  }),
  login: Login.annotate({
    default: { _tag: "None" },
    description: "How to log in to an account: none, or SASL with the options under it.",
  }),
  nicks: Schema.NonEmptyArray(Schema.String).annotate({
    description: "The nicks to use, the first preferred and the rest tried in turn.",
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
  username: Schema.String.annotate({
    description: "The username, the part of Self's mask before the @.",
    ...startsAsFirstNick,
  }),
});

/** The decoded form of {@link NetworkConfiguration}. */
export type NetworkConfiguration = typeof NetworkConfiguration.Type;
