/**
 * Where an Upload was said, read from the Timelines already folded, so nothing of it is
 * journaled (ADR 0016).
 *
 * @packageDocumentation
 */
import type { UploadId } from "@iirc/api";
import type { Item, TimelineStoreService } from "@iirc/timeline-store";
import { SearchText } from "@iirc/timelines";
import { Effect, Schema } from "effect";

/** How many Messages one read of the search takes. */
const pageSize = 100;

/**
 * What a Message of ours says: the text the Ircd confirmed, once it did, as search reads it.
 * @param item - The item.
 * @returns Its text, if it is a Message of ours the Ircd did not refuse.
 */
const oursSaid = (item: Item): string | undefined => {
  const { content } = item;

  // A refused Message was never said. One `Unsent` may have been, in part.
  if (
    content._tag !== "Message" ||
    content.ours === undefined ||
    content.ours.delivery._tag === "Rejected"
  ) {
    return undefined;
  }

  return content.ours.delivery._tag === "Confirmed" ? content.ours.delivery.text : content.text;
};

/**
 * Every Message of ours, on any Network, whose text holds `/<id>/`, newest first: the
 * search's matches, which fold case, kept to those that hold it exactly, as its link does.
 * @param store - The Timelines.
 * @param id - The Upload's id.
 * @returns The Messages.
 */
export const saidOf = (store: TimelineStoreService, id: UploadId) =>
  Effect.gen(function* () {
    const held = `/${id}/`;
    // Any id is one, of 18 characters none of which folds or breaks a line.
    const text = yield* Schema.decodeEffect(SearchText)(held).pipe(Effect.orDie);
    const said: Item[] = [];
    let after: Item | undefined;

    for (;;) {
      const page: readonly Item[] = yield* store.search({ after, limit: pageSize, text });

      said.push(...page.filter((item) => oursSaid(item)?.includes(held) === true));
      after = page.at(-1);

      if (page.length < pageSize) {
        return said;
      }
    }
  });
