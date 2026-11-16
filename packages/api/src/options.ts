/**
 * The Owner's options beyond `ui`, under the roots `store`, `uploads`, and `previews`: where
 * Uploads' bytes are kept, how Uploads are served, and how many bytes Previews' images may
 * take (ADR 0013, ADR 0016). They are the Owner's
 * rather than a device's, so no device overrides them. Each field is named in full, such as
 * `store.s3.bucket`, and says what it is and what it starts as in its annotations, which a
 * Frontend reads to offer every field as an option. A field with no `default` is unset until
 * set, and absent from the options in force. This module is the Schema alone, so a
 * Frontend's pure core can derive its options from it without the HTTP contract.
 *
 * @packageDocumentation
 */
import { CredentialName } from "@iirc/protocol/line";
import { Effect, Schema, SchemaAST, SchemaIssue, SchemaTransformation, Struct } from "effect";

/** What a Frontend reads of a URL the options name, where it is not the right kind of URL. */
const httpUrlMessage =
  "must be an absolute http or https URL, such as https://files.example.com/uploads, with no user, query, or fragment";

// A control character or a space, which the URL parser would strip or encode away.
const hasControlOrSpace = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;

    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
};

/**
 * Reads an absolute `http` or `https` URL, with a host, and with no user, no query, and no
 * fragment, in the form the URL itself writes it: its origin, which has the host in lower
 * case and the default port dropped, then its path with no trailing `/`, so a path may be
 * joined to it with `/` and two spellings of one URL are one text.
 * @param text - The text.
 * @returns The URL in that form, or none if it is not one.
 */
const httpUrlOf = (text: string): string | undefined => {
  if (text.includes("?") || text.includes("#") || hasControlOrSpace(text)) {
    return undefined;
  }

  const url = URL.parse(text);

  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.host === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }

  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
};

const isHttpUrlForm = (text: string): boolean => httpUrlOf(text) === text;

/**
 * An absolute `http` or `https` URL with no user, query, or fragment, such as
 * `https://files.example.com/uploads`. Any spelling of one is read as the URL itself writes
 * it, with the host in lower case, the default port dropped, and no trailing `/`, so a path
 * joins it with `/`, and what is held and journaled is the same for every spelling.
 */
export const HttpUrl = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.makeFilter((text: string) => isHttpUrlForm(text) || httpUrlMessage)),
    SchemaTransformation.transformEffect<string, string>({
      decode: (text, options) => {
        const url = httpUrlOf(text);

        return url === undefined
          ? Effect.fail(new SchemaIssue.InvalidValue({ message: httpUrlMessage }, text, options))
          : Effect.succeed(url);
      },
      encode: (url) => Effect.succeed(url),
    })
  )
).annotate({ identifier: "HttpUrl" });

/** The decoded form of {@link HttpUrl}. */
export type HttpUrl = typeof HttpUrl.Type;

const isLabel = (label: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label);

const isIpv4 = (host: string): boolean => {
  const parts = host.split(".");

  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)
  );
};

/**
 * Whether a host is a domain name, with at most one trailing dot, or an IPv4 address in
 * dotted quads, or an IPv6 address in brackets. Nothing is looked up.
 * @param host - The host.
 * @returns Whether it is one.
 */
const isListenHost = (host: string): boolean => {
  if (host.startsWith("[")) {
    const inside = host.slice(1, -1);

    return (
      host.endsWith("]") &&
      /^[0-9A-Fa-f:.]+$/u.test(inside) &&
      inside.includes(":") &&
      URL.canParse(`http://[${inside}]/`)
    );
  }

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const labels = name.split(".");

  // A last label of digits only is an address, never a name.
  if (/^\d+$/u.test(labels.at(-1) ?? "")) {
    return isIpv4(name);
  }

  return name.length <= 253 && labels.every(isLabel);
};

/**
 * Whether a text is `host:port`: a host as {@link isListenHost} says, and a port from 1 to
 * 65535 with no leading zero.
 * @param text - The text.
 * @returns Whether it is one.
 */
const isListenAddress = (text: string): boolean => {
  const colon = text.lastIndexOf(":");
  const port = text.slice(colon + 1);

  return (
    colon > 0 &&
    /^[1-9]\d{0,4}$/u.test(port) &&
    Number(port) <= 65_535 &&
    isListenHost(text.slice(0, colon))
  );
};

/**
 * Where a listener listens, as `host:port`: a domain name, which may end with one dot, or an
 * IPv4 address, or an IPv6 address in brackets, and a port from 1 to 65535, such as
 * `127.0.0.1:7668`.
 */
export const ListenAddress = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      isListenAddress(text) ||
      "must be host:port, such as 127.0.0.1:7668, with an IPv6 host in brackets"
  )
).annotate({ identifier: "ListenAddress" });

/** The decoded form of {@link ListenAddress}. */
export type ListenAddress = typeof ListenAddress.Type;

/**
 * A bucket's name, as S3 allows: 3 to 63 lower-case letters, digits, `.`, and `-`, starting
 * and ending with a letter or digit.
 */
export const BucketName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u, {
    message:
      "must be 3 to 63 lower-case letters, digits, . and -, starting and ending with a letter or digit",
  })
).annotate({ identifier: "BucketName" });

/** The decoded form of {@link BucketName}. */
export type BucketName = typeof BucketName.Type;

/**
 * A bucket's region: 1 to 64 lower-case letters, digits, and `-`, such as `us-east-1`, or
 * `auto` where the store has no regions of its own.
 */
export const RegionName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u, {
    message: "must be 1 to 64 lower-case letters, digits, and -, such as us-east-1",
  })
).annotate({ identifier: "RegionName" });

/** The decoded form of {@link RegionName}. */
export type RegionName = typeof RegionName.Type;

/** The least and the most a size in bytes may be: a byte, and the most a number holds exactly. */
export const byteCountBounds = { maximum: Number.MAX_SAFE_INTEGER, minimum: 1 } as const;

/** A size, as a whole number of bytes, at least one, within {@link byteCountBounds}. */
export const ByteCount = Schema.Int.check(Schema.isBetween(byteCountBounds)).annotate({
  identifier: "ByteCount",
});

/** The decoded form of {@link ByteCount}. */
export type ByteCount = typeof ByteCount.Type;

/** The least and the most days an Upload may be kept: a day, and a hundred years. */
export const expireAfterBounds = { maximum: 36_500, minimum: 1 } as const;

/** 100 MiB, in bytes: what `uploads.maxSize` starts as. */
export const defaultMaxSize = 104_857_600;

/** 1 GiB, in bytes: what `previews.maxTotal` starts as. */
export const defaultPreviewsMaxTotal = 1_073_741_824;

/**
 * The options under `store`, `uploads`, and `previews`, each named in full, with its
 * description, and with what it starts as where it starts as anything. One with no `default` is optional,
 * and absent until set.
 */
export const OwnerOptions = Schema.Struct({
  "previews.maxTotal": ByteCount.annotate({
    default: defaultPreviewsMaxTotal,
    description:
      "The most bytes the store may hold for Previews' images. 1073741824, 1 GiB, unless set; the least recently shown lose their images first.",
  }),
  "store.s3.accessKeyId": Schema.optionalKey(
    CredentialName.annotate({
      description: "The Credential holding the access key id of the bucket that keeps Uploads.",
    })
  ),
  "store.s3.bucket": Schema.optionalKey(
    BucketName.annotate({ description: "The name of the S3 bucket that keeps Uploads' bytes." })
  ),
  "store.s3.endpoint": Schema.optionalKey(
    HttpUrl.annotate({
      description:
        "The bucket's S3 endpoint, an http or https URL, such as https://s3.us-east-1.amazonaws.com.",
    })
  ),
  "store.s3.region": Schema.optionalKey(
    RegionName.annotate({ description: "The bucket's region, such as us-east-1, or auto." })
  ),
  "store.s3.secretAccessKey": Schema.optionalKey(
    CredentialName.annotate({
      description: "The Credential holding the secret access key of the bucket that keeps Uploads.",
    })
  ),
  "uploads.expireAfter": Schema.optionalKey(
    Schema.Int.check(Schema.isBetween(expireAfterBounds)).annotate({
      description: `How many days an Upload is kept before it is deleted, from ${expireAfterBounds.minimum} to ${expireAfterBounds.maximum}. Unset, Uploads are kept until deleted.`,
    })
  ),
  "uploads.listen": Schema.optionalKey(
    ListenAddress.annotate({
      description:
        "Where the listener that serves Uploads' links listens, as host:port, such as 127.0.0.1:7668.",
    })
  ),
  "uploads.maxSize": ByteCount.annotate({
    default: defaultMaxSize,
    description: "The largest an Upload may be, in bytes. 104857600, 100 MiB, unless set.",
  }),
  "uploads.maxTotal": Schema.optionalKey(
    ByteCount.annotate({
      description:
        "The most bytes the store may hold for live Uploads, each distinct file counted once; an upload that would pass it is refused, and nothing is evicted. Unset, there is no limit.",
    })
  ),
  "uploads.publicUrl": Schema.optionalKey(
    HttpUrl.annotate({
      description:
        "The base of every Upload's link, an http or https URL, such as https://files.example.com, kept without a trailing /.",
    })
  ),
});

/** The decoded form of {@link OwnerOptions}. */
export type OwnerOptions = typeof OwnerOptions.Type;

/** An option's full name, such as `store.s3.bucket`: one of {@link OwnerOptions}' fields. */
export const OwnerOptionName = Schema.Literals(Struct.keys(OwnerOptions.fields)).annotate({
  description: "An option under store, uploads, or previews, such as uploads.maxSize.",
  identifier: "OwnerOptionName",
});

/** The decoded form of {@link OwnerOptionName}. */
export type OwnerOptionName = typeof OwnerOptionName.Type;

/** Every option's full name under `store`, `uploads`, and `previews`, in the Schema's order. */
export const ownerOptionNames: readonly OwnerOptionName[] = OwnerOptionName.literals;

/**
 * What the options under `store`, `uploads`, and `previews` start as: each one with a
 * `default` annotation at it, and none of the others.
 */
export const ownerDefaults: OwnerOptions = Schema.decodeUnknownSync(OwnerOptions)(
  Object.fromEntries(
    ownerOptionNames.flatMap((name) => {
      const value = SchemaAST.resolve(OwnerOptions.fields[name].ast)?.default;

      return value === undefined ? [] : [[name, value]];
    })
  )
);

/**
 * The options that name a Credential, by the `CredentialName` identifier on their Schema,
 * as a Frontend finds them: each is set by naming a Credential the Vault holds.
 */
export const ownerCredentialOptions: readonly OwnerOptionName[] = ownerOptionNames.filter(
  (name) => SchemaAST.resolve(OwnerOptions.fields[name].ast)?.identifier === "CredentialName"
);

/**
 * How far the options under `store`, `uploads`, and `previews` have been changed: the sequence of the
 * last Change of one, or `0` before any, to send back as `ifSequence` with a change made
 * from it.
 */
export const OwnerSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The options under `store`, `uploads`, and `previews` in force, each one set or with a
 * default, and the sequence of the last Change of one.
 */
export const OwnerInForce = Schema.Struct({ options: OwnerOptions, sequence: OwnerSequence });

/** The decoded form of {@link OwnerInForce}. */
export type OwnerInForce = typeof OwnerInForce.Type;

/** An option's value under `store`, `uploads`, or `previews`, decoded by its Schema. */
export type OwnerOptionValue = Exclude<OwnerOptions[OwnerOptionName], undefined>;

/**
 * An option's value read from JSON, as a journaled Change or a request holds it, by its
 * Schema. Anything its Schema refuses is none.
 * @param option - The option.
 * @param value - Its value, as JSON.
 * @returns The value, or none.
 */
export const ownerValueKept = (
  option: OwnerOptionName,
  value: Schema.Json
): OwnerOptionValue | undefined => {
  const decoded = Schema.decodeOption(Schema.toCodecJson(OwnerOptions.fields[option]))(value);

  return decoded._tag === "Some" ? decoded.value : undefined;
};

const isCredentialName = Schema.is(CredentialName);

/**
 * The Credentials the options in force name, such as the bucket's keys, which removing a
 * Network never forgets.
 * @param options - The options in force.
 * @returns The Credentials they name.
 */
export const credentialsNamed = (options: OwnerOptions): ReadonlySet<CredentialName> =>
  new Set(
    ownerCredentialOptions.flatMap((name) => {
      const value = options[name];

      return isCredentialName(value) ? [value] : [];
    })
  );
