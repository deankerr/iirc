/**
 * The link fetch port: fetches a stranger's link for one purpose, and answers a body already
 * bounded for it, or refuses with a typed reason.
 *
 * @packageDocumentation
 */
import { Context, Schema } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { Precedence } from "./pacer.ts";

/**
 * Part of a stream, from `start` up to but not including `end`, as `Blob.slice` takes it.
 * Without `end`, it runs to the end. Both are whole numbers, and `start` is below `end`.
 */
export interface StreamRange {
  readonly start: number;
  readonly end?: number;
}

/** What a link is fetched for, which decides the types it may answer and its bounds. */
export type Purpose =
  | { readonly kind: "page" }
  | { readonly kind: "image" }
  | { readonly kind: "oembed" }
  | { readonly kind: "stream"; readonly range?: StreamRange };

/** The most a body gives, after decompression, and how long a fetch may take. */
export const limits = {
  /** A whole fetch, body and all, except a stream, for which it is the time to the first byte. */
  milliseconds: 10_000,
  oembed: 64 * 1024,
  /** A page ends here, as it does at the end of its head. */
  page: 1024 * 1024,
  /** A PNG, JPEG, GIF, WebP, or AVIF. */
  raster: 8 * 1024 * 1024,
  /** Redirects followed, each a new link. */
  redirects: 3,
  stream: 200 * 1024 * 1024,
  svg: 1024 * 1024,
} as const;

/** The policy refused the link or an address it led to. Never fetched. */
export class LinkRefused extends Schema.TaggedError<
  LinkRefused,
  { readonly brand: unique symbol }
>()("LinkRefused", { reason: Schema.String }) {}

/** The name did not resolve, or the connection failed or broke. */
export class LinkUnreachable extends Schema.TaggedError<
  LinkUnreachable,
  { readonly brand: unique symbol }
>()("LinkUnreachable", { reason: Schema.String }) {}

/** The fetch took longer than {@link limits}' `milliseconds`. */
export class LinkTimedOut extends Schema.TaggedError<
  LinkTimedOut,
  { readonly brand: unique symbol }
>()("LinkTimedOut", {}) {}

/** The body is, or said it would be, more than its purpose allows. */
export class LinkTooLarge extends Schema.TaggedError<
  LinkTooLarge,
  { readonly brand: unique symbol }
>()("LinkTooLarge", { limit: Schema.Finite }) {}

/**
 * The answer is not of a type its purpose takes, by its header or by its leading bytes.
 * `link` is the address that answered, after redirects, as the guard read it.
 */
export class LinkWrongType extends Schema.TaggedError<
  LinkWrongType,
  { readonly brand: unique symbol }
>()("LinkWrongType", { link: Schema.String, type: Schema.String }) {}

/** Why a body stopped before its end. */
export type BodyFailure = LinkTooLarge | LinkTimedOut | LinkUnreachable;

/** Why a fetch gave no answer. */
export type LinkFetchFailure =
  | LinkRefused
  | LinkUnreachable
  | LinkTimedOut
  | LinkTooLarge
  | LinkWrongType;

/** What a link answered, after any redirects. */
export interface Fetched {
  /** The last link fetched, by name, as the parser normalised it. */
  readonly link: string;
  readonly status: number;
  /**
   * The media type, checked against the purpose, lower-cased and without parameters. For an
   * image, it is the type its leading bytes show, which matched its header. A stream's `416`
   * is answered whatever its type, which is then unchecked, since it carries no media, and so
   * is any status outside 200 to 299 for any other purpose.
   */
  readonly type: string;
  /** Every header, by its lower-cased name. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The body as it arrives, decompressed and bounded for the purpose. A page ends early,
   * cleanly, at the end of its head or at its limit. Anything else over its limit fails. An
   * answer outside 200 to 299, but a stream's, has none, and none of it is read.
   */
  readonly body: Stream.Stream<Uint8Array, BodyFailure>;
}

/** What a link fetch adapter provides. */
export interface LinkFetchService {
  /**
   * Fetches a link for a purpose. The connection lives in the Scope: closing it stops the
   * fetch and its body, read or not. Its precedence orders it among fetches waiting for a
   * turn, `first` unless given.
   */
  readonly fetch: (
    link: string,
    purpose: Purpose,
    precedence?: Precedence
  ) => Effect.Effect<Fetched, LinkFetchFailure, Scope.Scope>;
}

/** How the Daemon fetches a stranger's link. */
export class LinkFetch extends Context.Service<LinkFetch, LinkFetchService>()(
  "@iirc/link-fetch/LinkFetch"
) {}
