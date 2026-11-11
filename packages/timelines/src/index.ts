/**
 * Timelines as a pure fold over News: each step in, the changes a Timeline store applies
 * out. `README.md` beside `src` is the written interface.
 *
 * @packageDocumentation
 */
export { delivered } from "./change.ts";

export type { Change, DeliveryChange } from "./change.ts";

export { levels, unreadCap } from "./content.ts";

export type { ActionRefusal, Content, Delivery, Level, OursItem } from "./content.ts";

export { emptyDirectory, projectionVersion, step } from "./fold.ts";

export type { Directory, Happened, Keyed, NetworkDirectory, Stepped } from "./fold.ts";

export { comparePositions, cursorOf, cursorsAfter, cursorsFrom, parseCursor } from "./position.ts";

export type { Position } from "./position.ts";

export {
  SearchText,
  foldForSearch,
  searchTextMaximum,
  searchFolding,
  searchTextMinimum,
  searchableOf,
} from "./search.ts";

export type { Searchable } from "./search.ts";

export { TimelineId, timelineIdOf } from "./timeline.ts";

export type { Descriptor, Kind } from "./timeline.ts";
