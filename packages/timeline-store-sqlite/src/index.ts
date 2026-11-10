/**
 * The production adapter of the Timeline store port, on SQLite. See the README for the
 * file's layout, its settings, and why a file it cannot use is made again.
 *
 * @packageDocumentation
 */
export { layerSqliteTimelineStore, makeSqliteTimelineStore } from "./sqlite-timeline-store.ts";

export type { OpenOptions } from "./sqlite-timeline-store.ts";
