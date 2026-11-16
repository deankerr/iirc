/**
 * The Preview cache port: keeps Previews by link. It is a cache outside the Journal (ADR
 * 0017), so emptying it loses nothing but fetches.
 *
 * @packageDocumentation
 */
import { Preview, PreviewFailure } from "@iirc/api";
import { Sha256 } from "@iirc/byte-store";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

/**
 * What a fetch of a link came to: `Ready`, with its Preview, or `Failed`, with why. A
 * Preview being fetched, or waiting for a press, is never kept.
 */
export const Settled = Schema.Union([
  Schema.TaggedStruct("Ready", { preview: Preview }),
  Schema.TaggedStruct("Failed", { reason: PreviewFailure }),
]).annotate({ identifier: "Settled" });

/** The decoded form of {@link Settled}. */
export type Settled = typeof Settled.Type;

/**
 * A link's record: what its fetch came to, the hash of the image it holds in the byte store,
 * or `null` for none, when it was fetched, and when it was last shown, each as milliseconds
 * since the epoch.
 */
export const Kept = Schema.Struct({
  fetched: Schema.Int,
  image: Schema.NullOr(Sha256),
  link: Schema.String,
  shown: Schema.Int,
  state: Settled,
}).annotate({ identifier: "Kept" });

/** The decoded form of {@link Kept}. */
export type Kept = typeof Kept.Type;

/** The cache could not be written or read. */
export class PreviewCacheFailed extends Schema.TaggedError<
  PreviewCacheFailed,
  { readonly brand: unique symbol }
>()("PreviewCacheFailed", { reason: Schema.String }) {}

/** What a Preview cache adapter provides. */
export interface PreviewCacheService {
  /** The record kept under a link, or `None`. */
  readonly get: (link: string) => Effect.Effect<Option.Option<Kept>, PreviewCacheFailed>;
  /** Keeps a record under its link, replacing any record kept there, whole or not at all. */
  readonly put: (kept: Kept) => Effect.Effect<void, PreviewCacheFailed>;
  /**
   * Says a link was shown at a time, moving when it was last shown to that time unless it was
   * already later, and gives its record as it then stands, or `None` when none is kept, which
   * it leaves so.
   */
  readonly shown: (
    link: string,
    at: number
  ) => Effect.Effect<Option.Option<Kept>, PreviewCacheFailed>;
}

/** The Preview cache port. */
export class PreviewCache extends Context.Service<PreviewCache, PreviewCacheService>()(
  "@iirc/preview-cache/PreviewCache"
) {}
